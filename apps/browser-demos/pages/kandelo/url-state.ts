import type {
  BootDescriptor,
  DescriptorMount,
  GalleryItem,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export const VFS_IMAGE_QUERY_PARAM = "vfs";

const VFS_IMAGE_QUERY_ALIASES = [
  VFS_IMAGE_QUERY_PARAM,
  "vfsUrl",
  "demoVfs",
  "demoVfsUrl",
  "image",
] as const;

export interface KandeloBootQuery {
  vfsImageUrl: string | null;
}

export interface TrustedVfsSourceCandidate<SourceId extends string> {
  id: SourceId;
  resolveVfsImageUrl: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
}

export function readKandeloBootQuery(search = currentSearch()): KandeloBootQuery {
  const params = new URLSearchParams(search);
  return {
    vfsImageUrl: normalizeVfsImageUrl(firstVfsImageQueryValue(params)),
  };
}

export function galleryItemUrl(
  item: GalleryItem,
  href = currentHref(),
): string {
  const url = new URL(href);
  url.searchParams.delete("demo");
  url.searchParams.delete("idle");
  clearVfsImageQueryParams(url.searchParams);
  if (item.vfsImageUrl) {
    // WHY: the demo id selects launch behavior while the exact URL identifies
    // the VFS image and its resource limit. Gallery navigation must preserve
    // both parts of that contract.
    url.searchParams.set("demo", item.id);
    url.searchParams.set(VFS_IMAGE_QUERY_PARAM, item.vfsImageUrl);
  }
  return url.href;
}

export function navigateToGalleryItemUrl(item: GalleryItem): void {
  const next = galleryItemUrl(item);
  if (next === window.location.href) return;
  window.location.assign(next);
}

/**
 * Point the address bar at a gallery item without leaving the document.
 *
 * WHY: a peer connection exists only in the document that opened it. Following
 * the URL would tear that document down and close the connection, and manual
 * signaling offers no way back — both people would have to exchange codes
 * again. A page holding a peer moves its URL rather than following it, so the
 * address stays shareable and the link survives the boot.
 */
export function replaceGalleryItemUrl(item: GalleryItem): void {
  const next = galleryItemUrl(item);
  if (next === window.location.href) return;
  window.history.replaceState(window.history.state, "", next);
}

export function vfsImageUrlFromDescriptor(
  descriptor: BootDescriptor,
  baseHref = currentHref(),
): string | null {
  const root = descriptor.mounts.find((mount) =>
    mount.path === "/" &&
    mount.source === "image" &&
    typeof mount.ref === "string"
  );
  const ref = root?.ref ?? null;
  if (!isUrlLikeImageRef(ref)) return null;
  return normalizeVfsImageUrl(ref, baseHref);
}

export function descriptorWithVfsImageUrl(
  descriptor: BootDescriptor,
  vfsImageUrl: string,
  opts: {
    id?: string;
    title?: string;
    packages?: string[];
  } = {},
): BootDescriptor {
  const normalizedVfsImageUrl = normalizeVfsImageUrl(vfsImageUrl) ?? vfsImageUrl;
  const id = opts.id ?? demoIdFromVfsImageUrl(normalizedVfsImageUrl);
  return {
    ...descriptor,
    id,
    title: opts.title ?? titleFromVfsImageUrl(normalizedVfsImageUrl),
    packages: opts.packages ?? descriptor.packages.slice(),
    mounts: mountsWithRootImageUrl(descriptor.mounts, normalizedVfsImageUrl),
  };
}

export function mountsWithRootImageUrl(
  mounts: DescriptorMount[],
  vfsImageUrl: string,
): DescriptorMount[] {
  let replaced = false;
  const next = mounts.map((mount) => {
    if (mount.path !== "/" || mount.source !== "image") return { ...mount };
    replaced = true;
    return { ...mount, ref: vfsImageUrl, readonly: false };
  });
  if (!replaced) {
    next.unshift({ path: "/", source: "image", ref: vfsImageUrl, readonly: false });
  }
  return next;
}

export function normalizeVfsImageUrl(
  raw: string | null | undefined,
  baseHref = currentHref(),
): string | null {
  const trimmed = nonEmpty(raw);
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed, baseHref);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/**
 * Match a URL to one exact trusted VFS source.
 *
 * Fragments describe launch behavior, not file identity, so they are ignored
 * here. Unmatched, duplicated, ambiguous, and unresolvable sources fail closed.
 */
export async function matchTrustedVfsSourceId<SourceId extends string>(
  vfsImageUrl: string,
  candidates: readonly TrustedVfsSourceCandidate<SourceId>[],
  baseHref = currentHref(),
): Promise<SourceId | null> {
  const normalized = normalizeVfsImageUrl(vfsImageUrl, baseHref);
  if (!normalized) return null;

  const ids = new Set<SourceId>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) return null;
    ids.add(candidate.id);
  }

  const requestedBase = withoutUrlHash(new URL(normalized));

  const matches = (
    await Promise.all(candidates.map(async (candidate) => ({
      id: candidate.id,
      baseUrl: await resolvedCandidateBaseUrl(candidate, baseHref),
    })))
  ).filter((candidate) => candidate.baseUrl === requestedBase);
  return matches.length === 1 ? matches[0].id : null;
}

export function demoIdFromVfsImageUrl(vfsImageUrl: string): string {
  let name = "custom-vfs";
  try {
    const url = new URL(vfsImageUrl, currentHref());
    name = url.pathname.split("/").filter(Boolean).pop() ?? name;
  } catch {
    name = vfsImageUrl.split(/[/?#]/).filter(Boolean).pop() ?? name;
  }
  name = name
    .replace(/\.vfs(?:\.zst)?$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return name || "custom-vfs";
}

export function titleFromVfsImageUrl(vfsImageUrl: string): string {
  const id = demoIdFromVfsImageUrl(vfsImageUrl);
  if (id === "custom-vfs") return "Custom VFS image";
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function firstVfsImageQueryValue(params: URLSearchParams): string | null {
  for (const key of VFS_IMAGE_QUERY_ALIASES) {
    const value = nonEmpty(params.get(key));
    if (value) return value;
  }
  return null;
}

function clearVfsImageQueryParams(params: URLSearchParams): void {
  for (const key of VFS_IMAGE_QUERY_ALIASES) {
    params.delete(key);
  }
}

async function resolvedCandidateBaseUrl<SourceId extends string>(
  candidate: TrustedVfsSourceCandidate<SourceId>,
  baseHref = currentHref(),
): Promise<string | null> {
  try {
    const resolved = await candidate.resolveVfsImageUrl();
    const normalized = normalizeVfsImageUrl(resolved, baseHref);
    return normalized ? withoutUrlHash(new URL(normalized)) : null;
  } catch {
    return null;
  }
}

function withoutUrlHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isUrlLikeImageRef(value: string | null | undefined): boolean {
  const trimmed = nonEmpty(value);
  if (!trimmed) return false;
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  );
}

function currentHref(): string {
  return typeof window === "undefined" ? "https://kandelo.local/" : window.location.href;
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}
