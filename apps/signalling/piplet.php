<?php

/**
 * The Kandelo signalling piplet.
 *
 * One self-modifying PHP file, in the spirit of WordPress/piplets: the
 * sessions live as JSON after `__halt_compiler()`, so there is no database,
 * package install, build step, or second file. Anything that serves PHP —
 * `php -S`, php-fpm behind a shared host, or PHP inside Kandelo itself —
 * is a complete deployment. Needs 64-bit PHP 8.3 or newer, and the server
 * user must be able to write the file's directory: a save writes a
 * temporary snapshot beside the file and atomically renames it into place.
 * The file rewrites itself on every session, so deploy a copy, not the
 * repository file:
 *
 *   cp piplet.php /srv/signalling/piplet.php
 *   php -S 0.0.0.0:8787 /srv/signalling/piplet.php
 *
 * It replaces the humans in the manually signalled WebRTC flow and nothing
 * more. One computer hosts a session under a chosen name and leaves its
 * invite code; the other asks for that name, takes the invite, and leaves
 * its answer code; the host polls the name until the answer appears. The
 * two codes are the same two `kandelo1:` strings the copy-paste flow
 * carries, and every byte of the machine still crosses the peer link —
 * this file only ever holds the two session descriptions. It does not
 * replace STUN: the peer link still learns each computer's public address
 * from its configured STUN servers, and two NATs that refuse a direct
 * route still fail at the ICE boundary.
 *
 * A session name is lowercase words separated by dashes — any number of
 * words, letters only, 64 characters at most, `^[a-z]+(-[a-z]+)*$`.
 * Clients must enforce the same rule before sending. The name is also the only
 * secret: whoever knows it can read the codes (which contain the peers'
 * addresses) or answer first — gaining a WebRTC link to a stranger, never
 * the machine's data, while the host sees a failed connection. Pick an
 * unguessable name for a session that crosses the open internet, and
 * serve this file over HTTPS so the codes do not travel in the clear.
 *
 * API, all JSON, all CORS-open:
 *
 *   GET  ?session=NAME              the session, or 404
 *   POST ?session=NAME&role=offer   host a session (replaces any previous)
 *   POST ?session=NAME&role=answer  answer a hosted session, once
 *
 * A code starts with `kandelo1:` and fits in 64 KiB. Sessions expire
 * after ten minutes; signalling either finished long before that or never
 * will. Test with `composer install && composer test`.
 */

const MATCH_SESSION_TTL_SECONDS = 600;
const MATCH_MAX_CODE_BYTES = 65536;
const MATCH_MAX_SESSIONS = 256;
const MATCH_NAME_PATTERN = '/^(?=.{1,64}$)[a-z]+(?:-[a-z]+)*$/D';
const MATCH_CODE_PREFIX = 'kandelo1:';
const MATCH_LOCK_DEADLINE_SECONDS = 2.0;

final class MatchHttpError extends Exception
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

function match_headers(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Cross-Origin-Resource-Policy: cross-origin');
}

function match_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES), "\n";
    exit;
}

function match_expired(array $session, int $now): bool
{
    return $session['created'] + MATCH_SESSION_TTL_SECONDS <= $now;
}

function match_read_sessions(): array
{
    $file = file_get_contents(__FILE__);
    if ($file === false) {
        throw new MatchHttpError(500, 'the session store cannot be read');
    }
    $data = json_decode(substr($file, __COMPILER_HALT_OFFSET__), true);
    if (!is_array($data) || !is_array($data['sessions'] ?? null)) {
        throw new MatchHttpError(500, 'the session store is corrupt');
    }
    return $data['sessions'];
}

function match_open_locked()
{
    $deadline = microtime(true) + MATCH_LOCK_DEADLINE_SECONDS;
    while (true) {
        $handle = fopen(__FILE__, 'r');
        if ($handle === false) {
            throw new MatchHttpError(500, 'the session store cannot be opened');
        }
        while (!flock($handle, LOCK_EX | LOCK_NB)) {
            if (microtime(true) > $deadline) {
                fclose($handle);
                header('Retry-After: 1');
                throw new MatchHttpError(503, 'the session store is busy');
            }
            usleep(20000);
        }
        $open = fstat($handle);
        $path = stat(__FILE__);
        if ($open !== false && $path !== false && $open['ino'] === $path['ino']) {
            return $handle;
        }
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function match_mutate(callable $mutate): void
{
    $handle = match_open_locked();
    try {
        $sessions = match_read_sessions();
        $mutate($sessions);
        $now = time();
        $sessions = array_filter(
            $sessions,
            fn (array $session) => !match_expired($session, $now),
        );
        $prefix = fread($handle, __COMPILER_HALT_OFFSET__);
        if ($prefix === false || strlen($prefix) !== __COMPILER_HALT_OFFSET__) {
            throw new MatchHttpError(500, 'the session store cannot be read');
        }
        $trailer = "\n" . json_encode(
            ['sessions' => $sessions],
            JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
        ) . "\n";
        $temporary = __DIR__ . '/.piplet-tmp-' . bin2hex(random_bytes(8)) . '.php';
        $out = fopen($temporary, 'x');
        if ($out === false) {
            throw new MatchHttpError(500, 'the session store cannot be written');
        }
        $content = $prefix . $trailer;
        $written = fwrite($out, $content) === strlen($content)
            && fflush($out)
            && fsync($out)
            && chmod($temporary, fileperms(__FILE__) & 0777)
            && rename($temporary, __FILE__);
        fclose($out);
        if (!$written) {
            @unlink($temporary);
            throw new MatchHttpError(500, 'the session store cannot be written');
        }
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function match_code(): string
{
    $code = file_get_contents('php://input', false, null, 0, MATCH_MAX_CODE_BYTES + 1);
    if ($code === false || $code === '' || strlen($code) > MATCH_MAX_CODE_BYTES) {
        throw new MatchHttpError(413, 'a connect code must be 1 to 65536 bytes');
    }
    $code = trim($code);
    if (!str_starts_with($code, MATCH_CODE_PREFIX)) {
        throw new MatchHttpError(422, 'this is not a Kandelo connect code');
    }
    return $code;
}

function match_run(): never
{
    match_headers();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    $name = $_GET['session'] ?? '';
    if (!is_string($name) || preg_match(MATCH_NAME_PATTERN, $name) !== 1) {
        throw new MatchHttpError(422, 'a session name is lowercase words separated by dashes, 64 characters at most');
    }
    if ($method === 'GET') {
        $session = match_read_sessions()[$name] ?? null;
        if ($session === null || match_expired($session, time())) {
            throw new MatchHttpError(404, "no session named \"$name\"");
        }
        match_json(['name' => $name, ...$session]);
    }
    if ($method !== 'POST') {
        header('Allow: GET, POST, OPTIONS');
        throw new MatchHttpError(405, 'use GET, POST, or OPTIONS');
    }
    $role = $_GET['role'] ?? '';
    $code = match_code();
    if ($role === 'offer') {
        match_mutate(function (array &$sessions) use ($name, $code): void {
            $live = array_filter(
                $sessions,
                fn (array $session, string $key) => $key !== $name && !match_expired($session, time()),
                ARRAY_FILTER_USE_BOTH,
            );
            if (count($live) >= MATCH_MAX_SESSIONS) {
                throw new MatchHttpError(503, 'the signalling server is full');
            }
            $sessions[$name] = ['offer' => $code, 'answer' => null, 'created' => time()];
        });
        match_json(['ok' => true], 201);
    }
    if ($role === 'answer') {
        match_mutate(function (array &$sessions) use ($name, $code): void {
            $session = $sessions[$name] ?? null;
            if ($session === null || match_expired($session, time())) {
                throw new MatchHttpError(404, "no session named \"$name\"");
            }
            if ($session['answer'] !== null) {
                throw new MatchHttpError(409, "the session \"$name\" is already answered");
            }
            $sessions[$name]['answer'] = $code;
        });
        match_json(['ok' => true]);
    }
    throw new MatchHttpError(422, 'the role is either "offer" or "answer"');
}

try {
    match_run();
} catch (MatchHttpError $error) {
    match_json(['error' => $error->getMessage()], $error->status);
} catch (Throwable $error) {
    error_log('signalling piplet failed: ' . $error->getMessage());
    match_json(['error' => 'the signalling server failed'], 500);
}

__halt_compiler();
{"sessions":{}}
