/**
 * The signalling-server exchange of the two peer-link codes.
 *
 * `apps/signalling/piplet.php` replaces the humans in the manually signalled
 * WebRTC flow: one computer hosts a session under a chosen name and leaves
 * its invite code, the other asks for that name, takes the invite, and
 * leaves its answer code, and the host polls the name until the answer
 * appears. The two codes are the same `kandelo1:` strings the copy-paste
 * flow carries — the server never holds anything else, and the peer link
 * itself is unchanged.
 *
 * A session name is lowercase words separated by dashes, 64 characters at
 * most. The server enforces the rule; validating here too turns a typo into
 * a message instead of a request. The name is the only secret: whoever
 * knows it can read the codes or answer first, so a session that crosses
 * the open internet deserves an unguessable name.
 */

export const SESSION_NAME_RULE =
  "a session name is lowercase words separated by dashes, 64 characters at most";

const SESSION_NAME_PATTERN = /^[a-z]+(-[a-z]+)*$/;
const SESSION_NAME_MAX_LENGTH = 64;
const ANSWER_POLL_MS = 2000;
/** The server forgets a session after ten minutes; polling past that asks
 * about a session that no longer exists. */
const ANSWER_WAIT_MS = 10 * 60 * 1000;

interface SignalledSession {
  offer: string;
  answer: string | null;
}

export function validSessionName(name: string): boolean {
  return (
    name.length <= SESSION_NAME_MAX_LENGTH && SESSION_NAME_PATTERN.test(name)
  );
}

function sessionUrl(server: string, name: string, role?: string): string {
  const url = new URL(server);
  url.searchParams.set("session", name);
  if (role) url.searchParams.set("role", role);
  return url.href;
}

async function refusal(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // A non-JSON refusal is not the piplet; the status line is all there is.
  }
  return `the signalling server answered ${response.status}`;
}

export async function postSessionOffer(
  server: string,
  name: string,
  invite: string,
): Promise<void> {
  const response = await fetch(sessionUrl(server, name, "offer"), {
    method: "POST",
    body: invite,
  });
  if (!response.ok) throw new Error(await refusal(response));
}

export async function readSession(
  server: string,
  name: string,
): Promise<SignalledSession> {
  const response = await fetch(sessionUrl(server, name));
  if (!response.ok) throw new Error(await refusal(response));
  return (await response.json()) as SignalledSession;
}

export async function postSessionAnswer(
  server: string,
  name: string,
  answer: string,
): Promise<void> {
  const response = await fetch(sessionUrl(server, name, "answer"), {
    method: "POST",
    body: answer,
  });
  if (!response.ok) throw new Error(await refusal(response));
}

/**
 * Poll the hosted session until its answer arrives.
 *
 * Returns null when `stillWanted` reports the attempt superseded — the
 * caller has moved on, so neither an answer nor an error is owed. A 404
 * while waiting means the session expired on the server before anyone
 * answered, and that is reported as the failure it is.
 */
export async function waitForSessionAnswer(
  server: string,
  name: string,
  stillWanted: () => boolean,
): Promise<string | null> {
  const deadline = Date.now() + ANSWER_WAIT_MS;
  while (stillWanted()) {
    if (Date.now() > deadline) {
      throw new Error(`the session "${name}" expired before an answer arrived`);
    }
    const { answer } = await readSession(server, name);
    if (answer !== null) return answer;
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
  }
  return null;
}
