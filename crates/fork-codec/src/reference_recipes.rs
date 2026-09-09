//! Decoder for the standalone fork reference-recipe wire image (KFRR).
//!
//! Ported from `decodeForkReferenceRecipes` in
//! `host/src/fork-reference-recipes.ts`. That wire image is the
//! activation-owned reconstruction recipe for Wasm reference values: it
//! "contains only integers and graph edges" so that a fresh fork Worker never
//! inherits live JavaScript/Wasm objects. The bytes are emitted by the REAL
//! TypeScript encoder `encodeForkReferenceRecipes` in the SAME module (this is
//! a TS-owned format, like `linked_frames`/`module_state`/`replay_events`, and
//! unlike the instrumenter-owned `gc_codec`/`imported_globals`); the committed
//! cross-language fixture is therefore produced by that real TS encoder (see
//! `crates/fork-codec/testdata/gen-reference-recipes-fixture.mts`) and decoded
//! field-for-field here.
//!
//! There is NO shared-ABI mirror for the KFRR framing constants: they live only
//! in `host/src/fork-reference-recipes.ts` (`WIRE_MAGIC`, `HEADER_SIZE = 40`,
//! `NODE_SIZE = 32`, `FORK_REFERENCE_RECIPE_VERSION = 1`). The distinct sibling
//! constants in `crates/shared/src/lib.rs` name the LIVE transaction/segment
//! formats (`WPK_FORK_REFERENCE_TRANSACTION_*` "KFRV",
//! `WPK_FORK_REFERENCE_SEGMENT_*` "KFRS", `WPK_FORK_REFERENCE_NODE_RECORD_SIZE`
//! = 48), not this standalone recipe image, so this module carries the KFRR
//! constants locally and documents their TS origin.
//!
//! Layout recap (all little-endian). A 40-byte header, then `node_count`
//! 32-byte node records in ascending recipe-id order, then `root_count` u32
//! root ids, then one canonical `edge_count` u32 edge vector, then
//! `blob_byte_length` exact scalar payload bytes.
//!
//! Header (40 bytes): `+0` magic `KFRR`, `+4` version (u16, 1), `+6` header
//! size (u16, 40), `+8` total byte length (u32), `+12` node count (u32), `+16`
//! root count (u32), `+20` edge count (u32), `+24` scalar blob byte length
//! (u32), `+28` node record size (u32, 32), `+32` reserved (u32, 0), `+36`
//! reserved (u32, 0).
//!
//! Node record (32 bytes): `+0` kind (u8), `+1` flags (u8, 0), `+2` reserved
//! (u16, 0), `+4` first (u32), `+8` second (u32), `+12` third (u32), `+16` edge
//! start (u32), `+20` edge count (u32), `+24` blob start (u32), `+28` blob byte
//! length (u32). Scalar kinds (null/funcref/externref/i31/static-root) carry no
//! aggregate data (edge/blob fields all zero); aggregate kinds
//! (exnref/struct/array) name a canonical, strictly-appended slice of the
//! shared edge and blob vectors (`edge_start`/`blob_start` must equal the
//! running append cursor, rejecting reordered or overlapping ranges).
//!
//! Field interpretation of the three scalar words per kind mirrors the TS
//! decoder exactly: funcref `(module_activation, function_ordinal)`, externref
//! a 64-bit `(second << 32) | first` handle constrained to `1..=0xffff_ffff`,
//! exnref `(module_activation, tag_ordinal, layout_id)`, i31 `first as i32`
//! constrained to `-0x4000_0000..=0x3fff_ffff`, struct/array
//! `(module_activation, type_ordinal, layout_id)`, static-root
//! `(module_activation, static_root_ordinal)`. Reserved scalar words are
//! required to be zero.
//!
//! This decoder is the pure `&[u8] -> struct` half: given the recipe image it
//! produces the owned, fully validated reference graph (canonical node ids
//! `0..node_count`, ordered roots, and every aggregate's ordered edges and
//! scalar bytes), exactly what `decodeForkReferenceRecipes` yields, including
//! the whole-graph reachability check. Every framing or consistency violation
//! (bad magic/version/header/node size, a nonzero reserved field, a declared
//! length that disagrees with the section, an out-of-range node/root/edge id, a
//! noncanonical or overlapping edge/blob range, a nonzero scalar word where the
//! kind requires zero, an out-of-domain externref handle or i31 value, an
//! unknown kind, or a node unreachable from every root) yields
//! `Err(Errno::EINVAL)`; the function never panics.
//!
//! The LIVE half is deferred to the co-resident module (Phase 6 D5+): the parts
//! of `host/src/fork-reference-recipes.ts` that are genuine runtime-instance
//! state rather than a byte format. Specifically the
//! `ForkReferenceRecipeCoordinator.replay` phase machine (parent/child
//! generation guards, the `ForkExternrefBroker` lease acquisition/rollback, the
//! `ForkReferenceReplayArena` allocate-then-connect-then-commit/abort
//! transaction, real externref/i31 materialization and
//! struct/array/exception aggregate construction, `ForkFunctionCatalog`/
//! `ForkStaticRootCatalog` `WebAssembly.Table` identity resolution, and the
//! `ForkReferenceTypeCatalog` source/target coordinate-ownership validation),
//! along with the SIBLING wire formats that carry live segmented transaction
//! state: `host/src/fork-reference-segments.ts` (KFRS segment records) and
//! `host/src/fork-reference-transaction.ts` (KFRV transaction manifest). Those
//! own real instance exports, host externrefs, and the transaction phase
//! machine, not a pure `&[u8]` decode, exactly as `imported_globals` deferred
//! its per-instance planner and `gc_codec` deferred its provenance registry.

use wasm_posix_shared::Errno;

use alloc::vec::Vec;

/// KFRR wire magic (`"KFRR"`, little-endian `0x5252_464b`). TS-owned; see the
/// module doc comment. Mirrors `WIRE_MAGIC` in
/// `host/src/fork-reference-recipes.ts`.
const MAGIC: u32 = 0x5252_464b;
/// Mirrors `FORK_REFERENCE_RECIPE_VERSION` (1).
const VERSION: u16 = 1;
/// Mirrors `HEADER_SIZE` (40).
const HEADER_SIZE: u32 = 40;
/// Mirrors `NODE_SIZE` (32).
const NODE_SIZE: u32 = 32;
/// Mirrors `MAX_I31` (`0x3fff_ffff`).
const MAX_I31: i32 = 0x3fff_ffff;
/// Mirrors `MIN_I31` (`-0x4000_0000`).
const MIN_I31: i32 = -0x4000_0000;

// Node kind discriminants; mirror the TS `WireNodeKind` const enum.
const KIND_NULL: u8 = 0;
const KIND_FUNCREF: u8 = 1;
const KIND_EXTERNREF: u8 = 2;
const KIND_EXNREF: u8 = 3;
const KIND_I31: u8 = 4;
const KIND_STRUCT: u8 = 5;
const KIND_ARRAY: u8 = 6;
const KIND_STATIC_ROOT: u8 = 7;

/// One decoded reference-recipe node. Mirrors the TS `ForkReferenceRecipeNode`
/// discriminated union: a pure integer/edge description of how the child
/// activation reconstructs one Wasm reference value. Aggregate variants
/// (`Exnref`/`Struct`/`Array`) carry their exact scalar payload bytes plus the
/// ordered graph edges (payloads/fields/elements) into other node ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReferenceRecipeNode {
    /// A definitely-null reference.
    Null,
    /// A function reference resolved from an activation's function catalog.
    Funcref {
        module_activation: u32,
        function_ordinal: u32,
    },
    /// A durable host externref resolved by broker handle (`1..=0xffff_ffff`).
    Externref { handle: u32 },
    /// A Wasm exception reference: a tag coordinate, an artifact layout id, the
    /// exact scalar payload bits, and the ordered reference payload edges.
    Exnref {
        module_activation: u32,
        tag_ordinal: u32,
        layout_id: u32,
        scalars: Vec<u8>,
        payloads: Vec<u32>,
    },
    /// An `i31ref` carrying a signed 31-bit value (`-0x4000_0000..=0x3fff_ffff`).
    I31 { value: i32 },
    /// A Wasm GC struct: a type coordinate, an artifact layout id, the exact
    /// packed/non-reference field bits, and the ordered reference field edges.
    Struct {
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        scalars: Vec<u8>,
        fields: Vec<u32>,
    },
    /// A Wasm GC array: a type coordinate, an artifact layout id, the exact
    /// scalar element bits, and the ordered reference element edges.
    Array {
        module_activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        scalars: Vec<u8>,
        elements: Vec<u32>,
    },
    /// A statically rooted reference resolved from an activation's static-root
    /// catalog.
    StaticRoot {
        module_activation: u32,
        static_root_ordinal: u32,
    },
}

/// One decoded graph entry. Mirrors the TS `ForkReferenceRecipeEntry`: the
/// canonical graph-local id (always the record index `0..node_count`) and its
/// node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceRecipeEntry {
    pub id: u32,
    pub node: ReferenceRecipeNode,
}

/// The fully decoded and validated reference-recipe graph. Mirrors what
/// `decodeForkReferenceRecipes` produces: ordered root ids plus canonical
/// nodes. The live replay (broker leases, arena materialization, catalog
/// ownership, and the transaction phase machine) is the deferred runtime half;
/// see the module doc comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceRecipes {
    pub roots: Vec<u32>,
    pub nodes: Vec<ReferenceRecipeEntry>,
}

/// Bounds-checked little-endian `u8` read.
fn r_u8(bytes: &[u8], off: u64) -> Result<u8, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    bytes.get(off).copied().ok_or(Errno::EINVAL)
}

/// Bounds-checked little-endian `u16` read.
fn r_u16(bytes: &[u8], off: u64) -> Result<u16, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

/// Bounds-checked little-endian `u32` read.
fn r_u32(bytes: &[u8], off: u64) -> Result<u32, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Total wire byte length for the given section counts, computed in `u64` so a
/// hostile 32-bit product cannot wrap. Mirrors the TS `wireByteLength`.
fn wire_byte_length(
    node_count: u32,
    root_count: u32,
    edge_count: u32,
    blob_byte_length: u32,
) -> Result<u64, Errno> {
    (HEADER_SIZE as u64)
        .checked_add((node_count as u64).checked_mul(NODE_SIZE as u64).ok_or(Errno::EINVAL)?)
        .and_then(|value| value.checked_add((root_count as u64).checked_mul(4)?))
        .and_then(|value| value.checked_add((edge_count as u64).checked_mul(4)?))
        .and_then(|value| value.checked_add(blob_byte_length as u64))
        .ok_or(Errno::EINVAL)
}

/// Running append cursors while decoding node records, so an aggregate's edge
/// and blob ranges must be strictly appended in node order.
struct Cursors {
    edge: u32,
    blob: u32,
}

/// Decode one 32-byte node record at `offset`. `edges` is the already-validated
/// shared edge vector (every entry `< node_count`); `blobs` is the shared
/// scalar-blob slice. `cursors` carries the canonical append positions.
fn decode_node_record(
    bytes: &[u8],
    offset: u64,
    edges: &[u32],
    blobs: &[u8],
    cursors: &mut Cursors,
) -> Result<ReferenceRecipeNode, Errno> {
    let kind = r_u8(bytes, offset)?;
    if r_u8(bytes, offset + 1)? != 0 || r_u16(bytes, offset + 2)? != 0 {
        return Err(Errno::EINVAL); // nonzero flags or reserved fields
    }
    let first = r_u32(bytes, offset + 4)?;
    let second = r_u32(bytes, offset + 8)?;
    let third = r_u32(bytes, offset + 12)?;
    let edge_start = r_u32(bytes, offset + 16)?;
    let edge_count = r_u32(bytes, offset + 20)?;
    let blob_start = r_u32(bytes, offset + 24)?;
    let blob_byte_length = r_u32(bytes, offset + 28)?;

    // A scalar kind carries no aggregate data at all.
    let require_no_aggregate = || -> Result<(), Errno> {
        if edge_start != 0 || edge_count != 0 || blob_start != 0 || blob_byte_length != 0 {
            return Err(Errno::EINVAL); // scalar record declares graph edges or payload bytes
        }
        Ok(())
    };

    // An aggregate kind names a strictly-appended slice of the shared vectors.
    // Both starts must equal the running cursor (canonical, non-overlapping)
    // and both ranges must lie within their vectors.
    let aggregate_edges = |cursors: &mut Cursors| -> Result<Vec<u32>, Errno> {
        if edge_start != cursors.edge {
            return Err(Errno::EINVAL); // noncanonical edge start
        }
        let edge_end = edge_start.checked_add(edge_count).ok_or(Errno::EINVAL)?;
        let slice = edges
            .get(edge_start as usize..edge_end as usize)
            .ok_or(Errno::EINVAL)?;
        cursors.edge = edge_end;
        Ok(slice.to_vec())
    };
    let aggregate_blob = |cursors: &mut Cursors| -> Result<Vec<u8>, Errno> {
        if blob_start != cursors.blob {
            return Err(Errno::EINVAL); // noncanonical blob start
        }
        let blob_end = blob_start.checked_add(blob_byte_length).ok_or(Errno::EINVAL)?;
        let slice = blobs
            .get(blob_start as usize..blob_end as usize)
            .ok_or(Errno::EINVAL)?;
        cursors.blob = blob_end;
        Ok(slice.to_vec())
    };

    match kind {
        KIND_NULL => {
            require_no_aggregate()?;
            if first != 0 || second != 0 || third != 0 {
                return Err(Errno::EINVAL); // noncanonical scalar fields
            }
            Ok(ReferenceRecipeNode::Null)
        }
        KIND_FUNCREF => {
            require_no_aggregate()?;
            if third != 0 {
                return Err(Errno::EINVAL); // funcref reserved scalar field is nonzero
            }
            Ok(ReferenceRecipeNode::Funcref {
                module_activation: first,
                function_ordinal: second,
            })
        }
        KIND_EXTERNREF => {
            require_no_aggregate()?;
            if third != 0 {
                return Err(Errno::EINVAL); // externref reserved scalar field is nonzero
            }
            // Combine both words exactly as the TS decoder; a nonzero high word
            // forces the handle past 0xffff_ffff and is rejected below.
            let handle = ((second as u64) << 32) | (first as u64);
            if handle == 0 || handle > 0xffff_ffff {
                return Err(Errno::EINVAL); // handle not a positive u32
            }
            Ok(ReferenceRecipeNode::Externref {
                handle: handle as u32,
            })
        }
        KIND_EXNREF => {
            let scalars = aggregate_blob(cursors)?;
            let payloads = aggregate_edges(cursors)?;
            Ok(ReferenceRecipeNode::Exnref {
                module_activation: first,
                tag_ordinal: second,
                layout_id: third,
                scalars,
                payloads,
            })
        }
        KIND_I31 => {
            require_no_aggregate()?;
            if second != 0 || third != 0 {
                return Err(Errno::EINVAL); // i31 reserved scalar field is nonzero
            }
            let value = first as i32;
            if !(MIN_I31..=MAX_I31).contains(&value) {
                return Err(Errno::EINVAL); // i31 value out of domain
            }
            Ok(ReferenceRecipeNode::I31 { value })
        }
        KIND_STRUCT => {
            let scalars = aggregate_blob(cursors)?;
            let fields = aggregate_edges(cursors)?;
            Ok(ReferenceRecipeNode::Struct {
                module_activation: first,
                type_ordinal: second,
                layout_id: third,
                scalars,
                fields,
            })
        }
        KIND_ARRAY => {
            let scalars = aggregate_blob(cursors)?;
            let elements = aggregate_edges(cursors)?;
            Ok(ReferenceRecipeNode::Array {
                module_activation: first,
                type_ordinal: second,
                layout_id: third,
                scalars,
                elements,
            })
        }
        KIND_STATIC_ROOT => {
            require_no_aggregate()?;
            if third != 0 {
                return Err(Errno::EINVAL); // static-root reserved scalar field is nonzero
            }
            Ok(ReferenceRecipeNode::StaticRoot {
                module_activation: first,
                static_root_ordinal: second,
            })
        }
        _ => Err(Errno::EINVAL), // unknown kind
    }
}

/// The ordered graph edges of a decoded node, mirroring the TS `nodeEdges`.
pub(crate) fn node_edges(node: &ReferenceRecipeNode) -> &[u32] {
    match node {
        ReferenceRecipeNode::Exnref { payloads, .. } => payloads,
        ReferenceRecipeNode::Struct { fields, .. } => fields,
        ReferenceRecipeNode::Array { elements, .. } => elements,
        ReferenceRecipeNode::Null
        | ReferenceRecipeNode::Funcref { .. }
        | ReferenceRecipeNode::Externref { .. }
        | ReferenceRecipeNode::I31 { .. }
        | ReferenceRecipeNode::StaticRoot { .. } => &[],
    }
}

/// Every node must be reachable from some root, mirroring the TS
/// `validateReachability`.
fn validate_reachability(recipes: &ReferenceRecipes) -> Result<(), Errno> {
    let mut reached = alloc::vec![false; recipes.nodes.len()];
    let mut pending: Vec<u32> = recipes.roots.clone();
    while let Some(id) = pending.pop() {
        let index = id as usize;
        // Roots and edges were already validated `< node_count`, so this index
        // is in range; the guard keeps the decoder panic-free regardless.
        if *reached.get(index).ok_or(Errno::EINVAL)? {
            continue;
        }
        reached[index] = true;
        for &edge in node_edges(&recipes.nodes[index].node) {
            pending.push(edge);
        }
    }
    if reached.iter().any(|&hit| !hit) {
        return Err(Errno::EINVAL); // a node is unreachable from every root
    }
    Ok(())
}

/// Decode and validate a standalone KFRR reference-recipe image.
///
/// `bytes` is the raw wire image. Returns the ordered, fully validated
/// reference graph (canonical node ids `0..node_count`, ordered roots, and each
/// aggregate's ordered edges and exact scalar bytes). Any framing or
/// consistency violation yields `Err(Errno::EINVAL)`; the function never panics.
///
/// Mirrors `decodeForkReferenceRecipes` in `host/src/fork-reference-recipes.ts`
/// under its default (representational u32) limits.
pub fn decode_reference_recipes(bytes: &[u8]) -> Result<ReferenceRecipes, Errno> {
    if (bytes.len() as u64) < HEADER_SIZE as u64 {
        return Err(Errno::EINVAL); // truncated header
    }
    // The representational wire bound is a u32; a larger buffer cannot describe
    // a valid image (the declared total length is a u32 field).
    if bytes.len() as u64 > 0xffff_ffff {
        return Err(Errno::EINVAL);
    }
    if r_u32(bytes, 0)? != MAGIC {
        return Err(Errno::EINVAL); // invalid magic
    }
    if r_u16(bytes, 4)? != VERSION {
        return Err(Errno::EINVAL); // unsupported version
    }
    if r_u16(bytes, 6)? != HEADER_SIZE as u16 {
        return Err(Errno::EINVAL); // invalid header size
    }
    if r_u32(bytes, 8)? as u64 != bytes.len() as u64 {
        return Err(Errno::EINVAL); // declared byte length does not match buffer
    }
    let node_count = r_u32(bytes, 12)?;
    let root_count = r_u32(bytes, 16)?;
    let edge_count = r_u32(bytes, 20)?;
    let blob_byte_length = r_u32(bytes, 24)?;
    if r_u32(bytes, 28)? != NODE_SIZE {
        return Err(Errno::EINVAL); // invalid node record size
    }
    if r_u32(bytes, 32)? != 0 || r_u32(bytes, 36)? != 0 {
        return Err(Errno::EINVAL); // reserved header fields are nonzero
    }
    let expected = wire_byte_length(node_count, root_count, edge_count, blob_byte_length)?;
    if expected != bytes.len() as u64 {
        return Err(Errno::EINVAL); // layout does not match declared counts
    }

    let roots_offset = HEADER_SIZE as u64 + (node_count as u64) * NODE_SIZE as u64;
    let edges_offset = roots_offset + (root_count as u64) * 4;
    let blobs_offset = edges_offset + (edge_count as u64) * 4;

    // Read and validate the shared edge vector: every id targets a real node.
    let mut edge_ids: Vec<u32> = Vec::with_capacity(edge_count as usize);
    for index in 0..edge_count as u64 {
        let id = r_u32(bytes, edges_offset + index * 4)?;
        if id >= node_count {
            return Err(Errno::EINVAL); // edge targets missing node
        }
        edge_ids.push(id);
    }

    // The shared scalar-blob slice.
    let blobs_start = usize::try_from(blobs_offset).map_err(|_| Errno::EINVAL)?;
    let blobs_end = blobs_start
        .checked_add(blob_byte_length as usize)
        .ok_or(Errno::EINVAL)?;
    let blobs = bytes.get(blobs_start..blobs_end).ok_or(Errno::EINVAL)?;

    let mut cursors = Cursors { edge: 0, blob: 0 };
    let mut nodes: Vec<ReferenceRecipeEntry> = Vec::with_capacity(node_count as usize);
    for id in 0..node_count {
        let offset = HEADER_SIZE as u64 + (id as u64) * NODE_SIZE as u64;
        let node = decode_node_record(bytes, offset, &edge_ids, blobs, &mut cursors)?;
        nodes.push(ReferenceRecipeEntry { id, node });
    }
    if cursors.edge != edge_count {
        return Err(Errno::EINVAL); // node records consume fewer edges than declared
    }
    if cursors.blob != blob_byte_length {
        return Err(Errno::EINVAL); // node records consume fewer scalar bytes than declared
    }

    let mut roots: Vec<u32> = Vec::with_capacity(root_count as usize);
    for index in 0..root_count as u64 {
        let id = r_u32(bytes, roots_offset + index * 4)?;
        if id >= node_count {
            return Err(Errno::EINVAL); // root targets missing node
        }
        roots.push(id);
    }

    let recipes = ReferenceRecipes { roots, nodes };
    validate_reachability(&recipes)?;
    Ok(recipes)
}

#[cfg(test)]
mod tests {
    use super::*;

    use alloc::vec;

    // --- Cross-language fixture (emitted by the real TS encoder) ----------

    /// Bytes are the standalone KFRR reference-recipe image emitted by the REAL
    /// TypeScript encoder `encodeForkReferenceRecipes`, via
    /// `crates/fork-codec/testdata/gen-reference-recipes-fixture.mts`. The
    /// generator encodes a graph exercising every node kind plus cycles,
    /// aliasing, duplicate roots, and both i31/handle domain boundaries; if the
    /// TS encoder and this decoder ever disagree on the wire format, the
    /// field-for-field test below catches the drift.
    const FIXTURE: &[u8] = include_bytes!("../testdata/reference-recipes-wasm32.bin");

    /// The expected decode of `FIXTURE`, matching the graph the generator
    /// encodes (input node ids are already canonical `0..11`, so decoded ids
    /// equal the encoder input ids).
    fn expected_fixture() -> ReferenceRecipes {
        ReferenceRecipes {
            // Duplicate root 0 exercises aliasing at the root level.
            roots: vec![0, 2, 5, 6, 7, 8, 9, 10, 0],
            nodes: vec![
                // id 0: struct referencing array(1), i31(4), exnref(3); part of
                // a cycle (array 1 points back at struct 0).
                ReferenceRecipeEntry {
                    id: 0,
                    node: ReferenceRecipeNode::Struct {
                        module_activation: 7,
                        type_ordinal: 2,
                        layout_id: 12,
                        scalars: vec![0x78, 0x56, 0x34, 0x12],
                        fields: vec![1, 4, 3],
                    },
                },
                // id 1: array with a back-edge to struct 0 and a shared edge to
                // exnref 3.
                ReferenceRecipeEntry {
                    id: 1,
                    node: ReferenceRecipeNode::Array {
                        module_activation: 7,
                        type_ordinal: 3,
                        layout_id: 13,
                        scalars: vec![0xaa, 0xbb],
                        elements: vec![0, 3],
                    },
                },
                // id 2: durable externref (small handle).
                ReferenceRecipeEntry {
                    id: 2,
                    node: ReferenceRecipeNode::Externref { handle: 9 },
                },
                // id 3: exception with scalar payload bits and reference edges.
                ReferenceRecipeEntry {
                    id: 3,
                    node: ReferenceRecipeNode::Exnref {
                        module_activation: 7,
                        tag_ordinal: 5,
                        layout_id: 15,
                        scalars: vec![0, 1, 2, 3, 4, 5, 6, 7],
                        payloads: vec![0, 4],
                    },
                },
                // id 4: negative i31.
                ReferenceRecipeEntry {
                    id: 4,
                    node: ReferenceRecipeNode::I31 { value: -17 },
                },
                // id 5: funcref.
                ReferenceRecipeEntry {
                    id: 5,
                    node: ReferenceRecipeNode::Funcref {
                        module_activation: 7,
                        function_ordinal: 0,
                    },
                },
                // id 6: null.
                ReferenceRecipeEntry {
                    id: 6,
                    node: ReferenceRecipeNode::Null,
                },
                // id 7: static root.
                ReferenceRecipeEntry {
                    id: 7,
                    node: ReferenceRecipeNode::StaticRoot {
                        module_activation: 6,
                        static_root_ordinal: 0,
                    },
                },
                // id 8: max positive i31.
                ReferenceRecipeEntry {
                    id: 8,
                    node: ReferenceRecipeNode::I31 { value: MAX_I31 },
                },
                // id 9: min negative i31.
                ReferenceRecipeEntry {
                    id: 9,
                    node: ReferenceRecipeNode::I31 { value: MIN_I31 },
                },
                // id 10: externref with the maximum handle.
                ReferenceRecipeEntry {
                    id: 10,
                    node: ReferenceRecipeNode::Externref {
                        handle: 0xffff_ffff,
                    },
                },
            ],
        }
    }

    #[test]
    fn decodes_real_encoder_fixture_field_for_field() {
        let decoded = decode_reference_recipes(FIXTURE).unwrap();
        assert_eq!(decoded, expected_fixture());
    }

    #[test]
    fn fixture_is_non_vacuous() {
        // Guard against a fixture that silently collapses to a trivial graph
        // (which would make the field-for-field test vacuously pass).
        let decoded = decode_reference_recipes(FIXTURE).unwrap();
        assert_eq!(decoded.nodes.len(), 11);
        assert_eq!(decoded.roots.len(), 9);
        // Every kind is represented.
        let kinds = |pred: fn(&ReferenceRecipeNode) -> bool| decoded.nodes.iter().any(|e| pred(&e.node));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::Null)));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::Funcref { .. })));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::Externref { .. })));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::Exnref { .. })));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::I31 { .. })));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::Struct { .. })));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::Array { .. })));
        assert!(kinds(|n| matches!(n, ReferenceRecipeNode::StaticRoot { .. })));
        // Aggregates actually carry scalar bytes and edges.
        assert!(decoded.nodes.iter().any(|e| matches!(
            &e.node,
            ReferenceRecipeNode::Struct { scalars, fields, .. }
                if !scalars.is_empty() && !fields.is_empty()
        )));
        // A cycle exists: struct 0 -> array 1 -> struct 0.
        assert!(node_edges(&decoded.nodes[0].node).contains(&1));
        assert!(node_edges(&decoded.nodes[1].node).contains(&0));
        // Root aliasing preserved.
        assert_eq!(decoded.roots[0], decoded.roots[8]);
        // Domain boundaries survived the round trip.
        assert!(decoded
            .nodes
            .iter()
            .any(|e| matches!(&e.node, ReferenceRecipeNode::I31 { value } if *value == MAX_I31)));
        assert!(decoded
            .nodes
            .iter()
            .any(|e| matches!(&e.node, ReferenceRecipeNode::I31 { value } if *value == MIN_I31)));
        assert!(decoded.nodes.iter().any(
            |e| matches!(&e.node, ReferenceRecipeNode::Externref { handle } if *handle == 0xffff_ffff)
        ));
    }

    // --- Hand-built minimal images (targeted framing/validation) ----------

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_header(
        bytes: &mut [u8],
        node_count: u32,
        root_count: u32,
        edge_count: u32,
        blob_byte_length: u32,
    ) {
        put_u32(bytes, 0, MAGIC);
        put_u16(bytes, 4, VERSION);
        put_u16(bytes, 6, HEADER_SIZE as u16);
        put_u32(bytes, 8, bytes.len() as u32);
        put_u32(bytes, 12, node_count);
        put_u32(bytes, 16, root_count);
        put_u32(bytes, 20, edge_count);
        put_u32(bytes, 24, blob_byte_length);
        put_u32(bytes, 28, NODE_SIZE);
        put_u32(bytes, 32, 0);
        put_u32(bytes, 36, 0);
    }

    /// Write a scalar (non-aggregate) node record at `off` with its three
    /// scalar words; all aggregate fields are zero.
    fn write_scalar_node(bytes: &mut [u8], off: usize, kind: u8, a: u32, b: u32, c: u32) {
        bytes[off] = kind;
        // flags (+1), reserved (+2..+4) stay zero.
        put_u32(bytes, off + 4, a);
        put_u32(bytes, off + 8, b);
        put_u32(bytes, off + 12, c);
        // edge/blob fields (+16..+32) stay zero.
    }

    /// A minimal single-null-node image: `roots: [0]`, `nodes: [null]`.
    fn minimal_image() -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_SIZE as usize + NODE_SIZE as usize + 4];
        write_header(&mut bytes, 1, 1, 0, 0);
        write_scalar_node(&mut bytes, HEADER_SIZE as usize, KIND_NULL, 0, 0, 0);
        // Root 0 at roots_offset = 40 + 32 = 72.
        put_u32(&mut bytes, HEADER_SIZE as usize + NODE_SIZE as usize, 0);
        bytes
    }

    #[test]
    fn decodes_minimal_image() {
        let decoded = decode_reference_recipes(&minimal_image()).unwrap();
        assert_eq!(
            decoded,
            ReferenceRecipes {
                roots: vec![0],
                nodes: vec![ReferenceRecipeEntry {
                    id: 0,
                    node: ReferenceRecipeNode::Null,
                }],
            }
        );
    }

    #[test]
    fn decodes_empty_graph() {
        // encodeForkReferenceRecipes({ roots: [], nodes: [] }) is a bare header.
        let mut bytes = vec![0u8; HEADER_SIZE as usize];
        write_header(&mut bytes, 0, 0, 0, 0);
        let decoded = decode_reference_recipes(&bytes).unwrap();
        assert!(decoded.roots.is_empty());
        assert!(decoded.nodes.is_empty());
    }

    fn decode_mutated(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ReferenceRecipes, Errno> {
        let mut bytes = minimal_image();
        mutate(&mut bytes);
        decode_reference_recipes(&bytes)
    }

    #[test]
    fn rejects_truncated_header() {
        let bytes = minimal_image();
        assert_eq!(
            decode_reference_recipes(&bytes[..HEADER_SIZE as usize - 1]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_bad_magic() {
        assert_eq!(decode_mutated(|b| put_u32(b, 0, MAGIC ^ 0xff)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_bad_version() {
        assert_eq!(decode_mutated(|b| put_u16(b, 4, VERSION + 1)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_bad_header_size() {
        assert_eq!(
            decode_mutated(|b| put_u16(b, 6, HEADER_SIZE as u16 + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_bad_node_size() {
        assert_eq!(decode_mutated(|b| put_u32(b, 28, NODE_SIZE + 1)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_declared_length_mismatch() {
        assert_eq!(decode_mutated(|b| put_u32(b, 8, 999)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_nonzero_reserved_header_fields() {
        assert_eq!(decode_mutated(|b| put_u32(b, 32, 1)), Err(Errno::EINVAL));
        assert_eq!(decode_mutated(|b| put_u32(b, 36, 1)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_unknown_kind() {
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize] = 99),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_nonzero_node_flags_or_reserved() {
        assert_eq!(
            decode_mutated(|b| b[HEADER_SIZE as usize + 1] = 1),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated(|b| put_u16(b, HEADER_SIZE as usize + 2, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_scalar_node_declaring_aggregate_data() {
        // A null node with a nonzero edge-count field.
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 20, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_noncanonical_null_scalar_fields() {
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + 4, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_out_of_range_root() {
        // Point the single root at node 1 (only node 0 exists).
        assert_eq!(
            decode_mutated(|b| put_u32(b, HEADER_SIZE as usize + NODE_SIZE as usize, 1)),
            Err(Errno::EINVAL)
        );
    }

    // A single-externref image, used for handle-domain checks.
    fn externref_image(first: u32, second: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_SIZE as usize + NODE_SIZE as usize + 4];
        write_header(&mut bytes, 1, 1, 0, 0);
        write_scalar_node(&mut bytes, HEADER_SIZE as usize, KIND_EXTERNREF, first, second, 0);
        put_u32(&mut bytes, HEADER_SIZE as usize + NODE_SIZE as usize, 0);
        bytes
    }

    #[test]
    fn decodes_externref_handle() {
        let decoded = decode_reference_recipes(&externref_image(42, 0)).unwrap();
        assert_eq!(decoded.nodes[0].node, ReferenceRecipeNode::Externref { handle: 42 });
    }

    #[test]
    fn rejects_zero_externref_handle() {
        assert_eq!(decode_reference_recipes(&externref_image(0, 0)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_externref_handle_above_u32() {
        // A nonzero high word forces the combined handle past 0xffff_ffff.
        assert_eq!(decode_reference_recipes(&externref_image(1, 1)), Err(Errno::EINVAL));
    }

    #[test]
    fn rejects_nonzero_externref_reserved_word() {
        // third != 0.
        let mut bytes = externref_image(1, 0);
        put_u32(&mut bytes, HEADER_SIZE as usize + 12, 1);
        assert_eq!(decode_reference_recipes(&bytes), Err(Errno::EINVAL));
    }

    // A single-i31 image.
    fn i31_image(raw: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_SIZE as usize + NODE_SIZE as usize + 4];
        write_header(&mut bytes, 1, 1, 0, 0);
        write_scalar_node(&mut bytes, HEADER_SIZE as usize, KIND_I31, raw, 0, 0);
        put_u32(&mut bytes, HEADER_SIZE as usize + NODE_SIZE as usize, 0);
        bytes
    }

    #[test]
    fn decodes_i31_domain_boundaries() {
        assert_eq!(
            decode_reference_recipes(&i31_image(MAX_I31 as u32)).unwrap().nodes[0].node,
            ReferenceRecipeNode::I31 { value: MAX_I31 }
        );
        assert_eq!(
            decode_reference_recipes(&i31_image(MIN_I31 as u32)).unwrap().nodes[0].node,
            ReferenceRecipeNode::I31 { value: MIN_I31 }
        );
    }

    #[test]
    fn rejects_out_of_domain_i31() {
        // MAX_I31 + 1 = 0x4000_0000 (still a positive i32, but out of i31 range).
        assert_eq!(decode_reference_recipes(&i31_image(0x4000_0000)), Err(Errno::EINVAL));
        // MIN_I31 - 1 = 0xbfff_ffff as u32 (i32 = -0x4000_0001).
        assert_eq!(
            decode_reference_recipes(&i31_image((MIN_I31 as i64 - 1) as u32)),
            Err(Errno::EINVAL)
        );
    }

    // --- Fixture-based negatives (mutations of the genuine fixture) -------

    fn decode_mutated_fixture(
        mutate: impl FnOnce(&mut Vec<u8>),
    ) -> Result<ReferenceRecipes, Errno> {
        let mut bytes = FIXTURE.to_vec();
        mutate(&mut bytes);
        decode_reference_recipes(&bytes)
    }

    #[test]
    fn rejects_out_of_range_edge_in_fixture() {
        // Node 0 (struct) is the first record; its first field edge lives at the
        // start of the shared edge vector. Point some edge at node_count (11).
        let node_count = 11u32;
        let edges_offset = HEADER_SIZE as usize
            + (node_count as usize) * NODE_SIZE as usize
            + 9 /* roots */ * 4;
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, edges_offset, node_count)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_noncanonical_edge_start_in_fixture() {
        // Node 0 is a struct; its edge-start word (record +16) must equal the
        // running cursor (0). Bump it to 1 to force a noncanonical range.
        assert_eq!(
            decode_mutated_fixture(|b| put_u32(b, HEADER_SIZE as usize + 16, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_broken_reachability_in_fixture() {
        // Redirect the duplicate trailing root (index 8, id 0) so node 0 becomes
        // unreachable... actually node 0 is still reachable via root 0 at index
        // 0. Instead, drop root index 0 (id 0) to a leaf so the cycle head is
        // orphaned. The struct/array/exnref/i31 cluster is only reachable via
        // root 0; retarget BOTH occurrences to a leaf (node 6, null).
        let node_count = 11usize;
        let roots_offset = HEADER_SIZE as usize + node_count * NODE_SIZE as usize;
        assert_eq!(
            decode_mutated_fixture(|b| {
                put_u32(b, roots_offset, 6); // index 0
                put_u32(b, roots_offset + 8 * 4, 6); // index 8
            }),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_truncations_never_panic() {
        for len in 0..=FIXTURE.len() {
            let _ = decode_reference_recipes(&FIXTURE[..len]);
        }
        let _ = decode_reference_recipes(&[]);
        let _ = decode_reference_recipes(&[0u8]);
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        for offset in 0..FIXTURE.len() {
            let mut bytes = FIXTURE.to_vec();
            bytes[offset] ^= 0xff;
            let _ = decode_reference_recipes(&bytes);
        }
        let base = minimal_image();
        for offset in 0..base.len() {
            let mut bytes = base.clone();
            bytes[offset] ^= 0xff;
            let _ = decode_reference_recipes(&bytes);
        }
    }

    #[test]
    fn fuzz_sweep_over_counts_never_panics() {
        // Sweep small count permutations in a fresh header over a fixed-size
        // buffer; most will be rejected, none may panic.
        for node_count in 0u32..6 {
            for root_count in 0u32..6 {
                for edge_count in 0u32..6 {
                    for blob in 0u32..6 {
                        let mut bytes = vec![0u8; 256];
                        write_header(&mut bytes, node_count, root_count, edge_count, blob);
                        // Vary the tail bytes so kind/edge fields take many values.
                        for (i, byte) in bytes.iter_mut().enumerate().skip(HEADER_SIZE as usize) {
                            *byte = (i as u8).wrapping_mul(31);
                        }
                        let _ = decode_reference_recipes(&bytes);
                    }
                }
            }
        }
    }
}
