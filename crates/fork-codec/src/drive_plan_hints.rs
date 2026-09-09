//! Real [`DrivePlanHints`] backed by decoded per-activation GC codec catalogs
//! (Phase 6 item 3c — the host flip's hint source).
//!
//! [`build_drive_plan`](crate::drive_plan::build_drive_plan) reproduces the JS
//! `materializeTypedGraph` drive-order, but the reference-recipe graph alone does
//! not carry the GC-layout facts that make the allocate order topological: which
//! of a struct/array's edges are *constructor* (allocation-time) dependencies
//! versus mutable fields filled later, which layouts are defaultable shells, and
//! the i31 / host-exception OWNER activations. Those live in the decoded
//! per-activation `kandelo.wpk_fork.gc_codec` catalog (a [`GcCodec`] per
//! activation) plus the activation metadata.
//!
//! [`GcCodecHints`] is the concrete [`DrivePlanHints`] the co-resident module
//! builds from those decoded catalogs, mirroring the JS
//! `ForkEarlyChildReferenceProvider` field-for-field:
//!
//! * [`allocation_dependencies`](DrivePlanHints::allocation_dependencies) ==
//!   `gcAllocationDependencies(node, layout)`
//!   (`host/src/fork-early-reference-provider.ts:304-338`): all
//!   `provenanceReferenceCount` provenance edges, then — for a struct — every
//!   snapshot edge whose layout field carries `FORK_GC_FIELD_ALLOCATION_DEPENDENCY`
//!   (indexed by the field's reference ordinal), or — for an array — the
//!   `ArrayFixed`/`ArrayNew` snapshot elements the constructor consumes.
//! * [`is_defaultable_shell`](DrivePlanHints::is_defaultable_shell) ==
//!   `(layout.flags & FORK_GC_LAYOUT_DEFAULTABLE_SHELL) !== 0`.
//! * [`i31_owner`](DrivePlanHints::i31_owner) == the JS `i31Owner`
//!   (`fork-early-reference-provider.ts:434-437`): the smallest activation id that
//!   declared a GC descriptor (i.e. the smallest activation with a seeded
//!   [`GcCodec`]). `None` when no activation declared one.
//! * [`exn_owner`](DrivePlanHints::exn_owner) == the JS `directOwner` for an
//!   exnref (`fork-early-reference-provider.ts:1131-1148`): the node's
//!   `module_activation`, or — for the reserved host-exception activation id
//!   [`FORK_HOST_EXCEPTION_ACTIVATION_ID`] — the `hostExceptionOwner` (the
//!   smallest activation that declared an exception descriptor,
//!   `fork-early-reference-provider.ts:438-441`), which the caller supplies.
//!
//! The recipe→layout mapping mirrors `validateGcRecipe`
//! (`fork-early-reference-provider.ts:268-302`): a struct/array recipe's
//! `layout_id` selects its layout from the owning activation's catalog (canonical
//! id order, `layout.id == index + 1`), and the recipe's `type_ordinal`/kind must
//! match the layout's. A recipe whose owner has no seeded catalog, whose
//! `layout_id` is unknown, or whose coordinate disagrees with the layout is a
//! truthful `Err(EINVAL)` — exactly where the JS provider throws — never a wrong
//! dependency order.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

use wasm_posix_shared::Errno;

use crate::drive_plan::DrivePlanHints;
use crate::gc_codec::{
    GcCodec, GcLayoutDescriptor, CONSTRUCTOR_ARRAY_FIXED, CONSTRUCTOR_ARRAY_NEW,
    FIELD_FLAG_ALLOCATION_DEPENDENCY, FIELD_FLAG_REFERENCE, KIND_ARRAY, KIND_STRUCT,
    LAYOUT_FLAG_DEFAULTABLE_SHELL,
};
use crate::reference_recipes::{ReferenceRecipeEntry, ReferenceRecipeNode};

/// The reserved module-activation id an exnref recipe carries when the exception
/// it reconstructs is a HOST exception (remapped to `hostExceptionOwner`).
/// Mirrors `FORK_HOST_EXCEPTION_ACTIVATION_ID` in
/// `host/src/fork-reference-transaction.ts:48`.
pub const FORK_HOST_EXCEPTION_ACTIVATION_ID: u32 = 0xffff_ffff;

/// A concrete [`DrivePlanHints`] built from decoded per-activation GC codec
/// catalogs. See the module docs; every hint is precomputed in [`Self::new`] so
/// the trait methods are pure lookups.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcCodecHints {
    /// recipe id -> its ordered constructor-dependency edges (empty when it has
    /// none). Only struct/array recipes have an entry.
    deps: BTreeMap<u32, Vec<u32>>,
    /// recipe ids whose layout is a defaultable shell.
    shells: BTreeSet<u32>,
    /// The i31-owner activation (smallest GC-declaring activation), if any.
    i31_owner: Option<u32>,
    /// recipe id -> the exnref's owner activation (its `directOwner`). Absent for
    /// a host-exception exnref when no host-exception owner was supplied, so
    /// `exn_owner` returns `None` and `build_drive_plan` fails loudly.
    exn_owners: BTreeMap<u32, u32>,
}

impl GcCodecHints {
    /// Build the hints for `nodes` from the decoded per-activation catalogs
    /// `gc_codecs` (keyed by activation id), remapping a host-exception exnref to
    /// `host_exception_owner` (the smallest activation with an exception
    /// descriptor; the caller derives it exactly as the JS constructor does).
    ///
    /// Returns `Err(EINVAL)` on a struct/array recipe whose owner has no seeded
    /// catalog, whose `layout_id` is unknown, or whose type-ordinal/kind
    /// coordinate disagrees with the layout — the truthful failures the JS
    /// `validateGcRecipe`/`gcAllocationDependencies` throw. Never panics.
    pub fn new(
        nodes: &[ReferenceRecipeEntry],
        gc_codecs: &BTreeMap<u32, GcCodec>,
        host_exception_owner: Option<u32>,
    ) -> Result<Self, Errno> {
        // i31Owner: the smallest activation that declared a GC descriptor. In the
        // module that is exactly the smallest activation with a seeded catalog.
        let i31_owner = gc_codecs.keys().min().copied();

        let mut deps: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        let mut shells: BTreeSet<u32> = BTreeSet::new();
        let mut exn_owners: BTreeMap<u32, u32> = BTreeMap::new();

        for entry in nodes {
            match &entry.node {
                ReferenceRecipeNode::Struct {
                    module_activation,
                    type_ordinal,
                    layout_id,
                    fields,
                    ..
                } => {
                    let layout = require_layout(
                        gc_codecs,
                        *module_activation,
                        *layout_id,
                        *type_ordinal,
                        KIND_STRUCT,
                        fields.len(),
                    )?;
                    deps.insert(entry.id, gc_allocation_dependencies(fields, true, layout)?);
                    if layout.flags & LAYOUT_FLAG_DEFAULTABLE_SHELL != 0 {
                        shells.insert(entry.id);
                    }
                }
                ReferenceRecipeNode::Array {
                    module_activation,
                    type_ordinal,
                    layout_id,
                    elements,
                    ..
                } => {
                    let layout = require_layout(
                        gc_codecs,
                        *module_activation,
                        *layout_id,
                        *type_ordinal,
                        KIND_ARRAY,
                        elements.len(),
                    )?;
                    deps.insert(entry.id, gc_allocation_dependencies(elements, false, layout)?);
                    if layout.flags & LAYOUT_FLAG_DEFAULTABLE_SHELL != 0 {
                        shells.insert(entry.id);
                    }
                }
                ReferenceRecipeNode::Exnref {
                    module_activation, ..
                } => {
                    // directOwner: node.module_activation, or the host-exception
                    // owner for the reserved host activation id. When a host
                    // exception has no owner, leave the entry absent so `exn_owner`
                    // is `None` and `build_drive_plan` fails loudly (the JS `!`).
                    let owner = if *module_activation == FORK_HOST_EXCEPTION_ACTIVATION_ID {
                        match host_exception_owner {
                            Some(owner) => owner,
                            None => continue,
                        }
                    } else {
                        *module_activation
                    };
                    exn_owners.insert(entry.id, owner);
                }
                _ => {}
            }
        }

        Ok(Self {
            deps,
            shells,
            i31_owner,
            exn_owners,
        })
    }
}

impl DrivePlanHints for GcCodecHints {
    fn allocation_dependencies(&self, recipe_id: u32) -> &[u32] {
        self.deps
            .get(&recipe_id)
            .map(|deps| deps.as_slice())
            .unwrap_or(&[])
    }

    fn is_defaultable_shell(&self, recipe_id: u32) -> bool {
        self.shells.contains(&recipe_id)
    }

    fn i31_owner(&self) -> Option<u32> {
        self.i31_owner
    }

    fn exn_owner(&self, recipe_id: u32) -> Option<u32> {
        self.exn_owners.get(&recipe_id).copied()
    }
}

/// Resolve a struct/array recipe's layout from its owning activation's catalog and
/// verify the coordinate, mirroring `validateGcRecipe`
/// (`fork-early-reference-provider.ts:268-302`) and `ForkGcCodecDescriptor.require`
/// (`fork-gc-codec.ts:248-253`).
fn require_layout<'a>(
    gc_codecs: &'a BTreeMap<u32, GcCodec>,
    activation: u32,
    layout_id: u32,
    type_ordinal: u32,
    kind: u8,
    reference_count: usize,
) -> Result<&'a GcLayoutDescriptor, Errno> {
    let codec = gc_codecs.get(&activation).ok_or(Errno::EINVAL)?;
    // Canonical id order: `layouts[id - 1].id == id` (validated on decode).
    let index = layout_id.checked_sub(1).ok_or(Errno::EINVAL)? as usize;
    let layout = codec.layouts.get(index).ok_or(Errno::EINVAL)?;
    if layout.id != layout_id {
        return Err(Errno::EINVAL); // non-canonical catalog
    }
    // validateGcRecipe: type/kind coordinate + truncated-provenance check.
    if layout.type_ordinal != type_ordinal
        || layout.kind != kind
        || reference_count < layout.provenance_reference_count as usize
    {
        return Err(Errno::EINVAL);
    }
    Ok(layout)
}

/// Faithful port of `gcAllocationDependencies`
/// (`host/src/fork-early-reference-provider.ts:304-338`). `edges` is the recipe's
/// ordered reference edges (`node.fields` for a struct, `node.elements` for an
/// array), laid out as `[ ...provenance refs, ...snapshot refs ]`.
fn gc_allocation_dependencies(
    edges: &[u32],
    is_struct: bool,
    layout: &GcLayoutDescriptor,
) -> Result<Vec<u32>, Errno> {
    let prov = layout.provenance_reference_count as usize;
    if edges.len() < prov {
        return Err(Errno::EINVAL); // truncated constructor provenance
    }
    // dependencies = edges.slice(0, provenanceReferenceCount)
    let mut dependencies: Vec<u32> = edges[..prov].to_vec();
    let snapshot_start = prov;

    if is_struct {
        for field in &layout.fields {
            if field.flags & FIELD_FLAG_ALLOCATION_DEPENDENCY != 0 {
                if let Some(ordinal) = field.reference_ordinal {
                    let index = snapshot_start
                        .checked_add(ordinal as usize)
                        .ok_or(Errno::EINVAL)?;
                    // JS `edges[snapshotStart + referenceOrdinal]!` — a
                    // non-null assert; an out-of-range index is corruption.
                    dependencies.push(*edges.get(index).ok_or(Errno::EINVAL)?);
                }
            }
        }
        return Ok(dependencies);
    }

    // Array arms. `layout.fields[0]` is the single element descriptor.
    let element = layout.fields.first().ok_or(Errno::EINVAL)?;
    if element.flags & FIELD_FLAG_REFERENCE == 0 {
        return Ok(dependencies); // non-reference element array has no ref deps
    }
    let snapshot = &edges[snapshot_start..];
    if layout.constructor == CONSTRUCTOR_ARRAY_FIXED {
        if prov == 0 {
            dependencies.extend_from_slice(snapshot);
        }
    } else if layout.constructor == CONSTRUCTOR_ARRAY_NEW && prov == 0 && !snapshot.is_empty() {
        dependencies.push(snapshot[0]);
    }
    Ok(dependencies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive_plan::{
        build_drive_plan, drive_table_base, DriveStep, DRIVE_OP_ALLOC, DRIVE_OP_EXN,
        DRIVE_OP_EXTERNREF_TRANSIT, DRIVE_OP_FILL,
    };
    use crate::gc_codec::decode_gc_codec;
    use alloc::vec;

    // The same committed descriptor the gc_codec decoder tests use: seven real
    // layouts emitted by the Rust instrumenter. See `gc_codec.rs`.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/gc-codec-wasm32.bin");

    fn codec_map(activation: u32) -> BTreeMap<u32, GcCodec> {
        let mut map = BTreeMap::new();
        map.insert(activation, decode_gc_codec(TS_FIXTURE).unwrap());
        map
    }

    fn entry(id: u32, node: ReferenceRecipeNode) -> ReferenceRecipeEntry {
        ReferenceRecipeEntry { id, node }
    }

    fn struct_node(
        id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        fields: Vec<u32>,
    ) -> ReferenceRecipeEntry {
        entry(
            id,
            ReferenceRecipeNode::Struct {
                module_activation: activation,
                type_ordinal,
                layout_id,
                scalars: vec![0u8; 4],
                fields,
            },
        )
    }

    fn array_node(
        id: u32,
        activation: u32,
        type_ordinal: u32,
        layout_id: u32,
        elements: Vec<u32>,
    ) -> ReferenceRecipeEntry {
        entry(
            id,
            ReferenceRecipeNode::Array {
                module_activation: activation,
                type_ordinal,
                layout_id,
                scalars: Vec::new(),
                elements,
            },
        )
    }

    fn triple(step: &DriveStep) -> (u32, u32, u32) {
        (step.op, step.slot, step.recipe)
    }

    // -- Hand-built descriptor with a struct ALLOCATION_DEPENDENCY field --------
    //
    // The committed fixture has no struct whose field is a constructor
    // dependency, so build one through the REAL decode path: a struct layout with
    // one immutable i32 scalar and TWO immutable reference fields, the SECOND of
    // which is an allocation dependency (an immutable-constructor chain).

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }
    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    // Structural constants (mirror `gc_codec.rs`; only what this fixture needs).
    const MAGIC: [u8; 4] = *b"KFGC";
    const HDR: usize = 16;
    const LAYOUT_REC: usize = 44;
    const FIELD_REC: usize = 12;
    const STORAGE_I32: u8 = 3;
    const STORAGE_REF: u8 = 8;
    const F_MUTABLE: u8 = 1 << 0;
    const F_NULLABLE: u8 = 1 << 1;
    const F_REFERENCE: u8 = 1 << 2;
    const F_ALLOC_DEP: u8 = 1 << 3;

    /// One struct layout (id 1, type ordinal 0): `[ i32 scalar, ref#0, ref#1 ]`
    /// where ref#1 is an immutable allocation dependency. No provenance.
    fn struct_dep_descriptor() -> Vec<u8> {
        let mut bytes = vec![0u8; HDR + LAYOUT_REC + 3 * FIELD_REC];
        bytes[0..4].copy_from_slice(&MAGIC);
        put_u16(&mut bytes, 4, 1); // version
        put_u16(&mut bytes, 6, HDR as u16); // header size
        put_u32(&mut bytes, 8, 1); // layout count
        put_u32(&mut bytes, 12, 3); // field count

        let l = HDR;
        put_u32(&mut bytes, l, 1); // id
        put_u32(&mut bytes, l + 4, 0); // type ordinal
        bytes[l + 8] = KIND_STRUCT;
        bytes[l + 9] = 0; // ConstructorStruct
        put_u16(&mut bytes, l + 10, 0); // flags
        put_u32(&mut bytes, l + 12, 4); // scalar length (one i32)
        put_u32(&mut bytes, l + 16, 0); // field start
        put_u32(&mut bytes, l + 20, 3); // field count
        put_u32(&mut bytes, l + 24, 0xffff_ffff); // super-type ordinal none
        put_u32(&mut bytes, l + 28, 1); // base layout id
        put_u32(&mut bytes, l + 32, 0); // auxiliary
        put_u32(&mut bytes, l + 36, 0); // provenance scalar length
        put_u32(&mut bytes, l + 40, 0); // provenance reference count

        // field 0: i32 scalar at offset 0 (mutable).
        let f0 = l + LAYOUT_REC;
        bytes[f0] = STORAGE_I32;
        bytes[f0 + 1] = F_MUTABLE;
        put_u32(&mut bytes, f0 + 4, 0); // scalar offset
        put_u32(&mut bytes, f0 + 8, 0xffff_ffff); // reference ordinal none

        // field 1: reference ordinal 0, mutable+nullable (a mutable field, NOT a
        // dependency).
        let f1 = f0 + FIELD_REC;
        bytes[f1] = STORAGE_REF;
        bytes[f1 + 1] = F_MUTABLE | F_NULLABLE | F_REFERENCE;
        put_u32(&mut bytes, f1 + 4, 0xffff_ffff); // scalar offset none
        put_u32(&mut bytes, f1 + 8, 0); // reference ordinal 0

        // field 2: reference ordinal 1, immutable allocation dependency.
        let f2 = f1 + FIELD_REC;
        bytes[f2] = STORAGE_REF;
        bytes[f2 + 1] = F_NULLABLE | F_REFERENCE | F_ALLOC_DEP;
        put_u32(&mut bytes, f2 + 4, 0xffff_ffff); // scalar offset none
        put_u32(&mut bytes, f2 + 8, 1); // reference ordinal 1
        bytes
    }

    #[test]
    fn hand_built_struct_dep_descriptor_decodes() {
        // Guard: the descriptor really decodes to one struct layout with the
        // allocation-dependency field, so the tests below are non-vacuous.
        let codec = decode_gc_codec(&struct_dep_descriptor()).unwrap();
        assert_eq!(codec.layouts.len(), 1);
        let layout = &codec.layouts[0];
        assert_eq!(layout.kind, KIND_STRUCT);
        assert_eq!(layout.fields.len(), 3);
        assert!(layout.fields[2].flags & FIELD_FLAG_ALLOCATION_DEPENDENCY != 0);
        assert_eq!(layout.fields[2].reference_ordinal, Some(1));
    }

    #[test]
    fn struct_allocation_dependency_orders_dep_before_dependent() {
        // struct(0) has an immutable allocation-dependency field pointing at
        // struct(1) via reference ordinal 1 (the SECOND ref edge); its FIRST ref
        // edge (ordinal 0) is a mutable field over externref(2). So struct(0)'s
        // edge list is [mutable->externref(2), dependency->struct(1)], and struct(1)
        // MUST be allocated before struct(0). struct(1)'s own dependency edge
        // (ordinal 1) points at the externref leaf, so its dependency chain ends.
        // Mutation guard: an id-order builder would allocate struct(0) first.
        let mut map = BTreeMap::new();
        map.insert(0u32, decode_gc_codec(&struct_dep_descriptor()).unwrap());
        let nodes = vec![
            struct_node(0, 0, 0, 1, vec![2, 1]), // dep ordinal 1 -> struct(1)
            struct_node(1, 0, 0, 1, vec![2, 2]), // dep ordinal 1 -> externref(2)
            entry(2, ReferenceRecipeNode::Externref { handle: 9 }),
        ];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        // The dependencies the adapter derived from the descriptor.
        assert_eq!(hints.allocation_dependencies(0), &[1]);
        assert_eq!(hints.allocation_dependencies(1), &[2]);

        let plan = build_drive_plan(&nodes, &hints).unwrap();
        let allocs: Vec<u32> = plan
            .iter()
            .filter(|s| s.op == DRIVE_OP_ALLOC)
            .map(|s| s.recipe)
            .collect();
        assert_eq!(allocs, vec![1, 0]); // dependency struct(1) first, then struct(0)
        // Full order: the reachable externref leaf (recipe 2) is published into the
        // transit first, then ALLOC 1, ALLOC 0, then fills in id order (0 then 1).
        assert_eq!(
            plan.iter().map(|s| (s.op, s.recipe)).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 2),
                (DRIVE_OP_ALLOC, 1),
                (DRIVE_OP_ALLOC, 0),
                (DRIVE_OP_FILL, 0),
                (DRIVE_OP_FILL, 1),
            ]
        );
    }

    #[test]
    fn immutable_constructor_cycle_from_descriptors_is_einval() {
        // Two structs that each name the OTHER as an immutable allocation
        // dependency: an unbreakable cycle. `build_drive_plan` must return EINVAL
        // (the JS throw), never a wrong order.
        let mut map = BTreeMap::new();
        map.insert(0u32, decode_gc_codec(&struct_dep_descriptor()).unwrap());
        let nodes = vec![
            // each struct's dependency (ref ordinal 1) points at the other.
            struct_node(0, 0, 0, 1, vec![2, 1]),
            struct_node(1, 0, 0, 1, vec![2, 0]),
            entry(2, ReferenceRecipeNode::Externref { handle: 9 }),
        ];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert_eq!(hints.allocation_dependencies(0), &[1]);
        assert_eq!(hints.allocation_dependencies(1), &[0]);
        assert_eq!(build_drive_plan(&nodes, &hints), Err(Errno::EINVAL));
    }

    #[test]
    fn defaultable_shell_flag_comes_from_the_layout() {
        // Fixture layout 1 (type ordinal 0, struct) carries DEFAULTABLE_SHELL. A
        // struct recipe using it is pre-allocated before the identity walk.
        let map = codec_map(0);
        let nodes = vec![
            struct_node(0, 0, 0, 1, vec![0, 0]), // two self-referential ref fields
        ];
        // layout 1 has two reference fields (ordinals 0,1) and one i32 scalar; the
        // recipe supplies two edges (both to itself). Neither field is an
        // allocation dependency, so the shell has no deps.
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert!(hints.is_defaultable_shell(0));
        assert!(hints.allocation_dependencies(0).is_empty());
        let plan = build_drive_plan(&nodes, &hints).unwrap();
        // Shell pre-allocated first (one alloc), then filled.
        assert_eq!(
            plan.iter().map(|s| (s.op, s.recipe)).collect::<Vec<_>>(),
            vec![(DRIVE_OP_ALLOC, 0), (DRIVE_OP_FILL, 0)]
        );
    }

    #[test]
    fn array_generic_reference_element_has_no_constructor_dependencies() {
        // Fixture layout 4 is `array` generic (ArrayGeneric, type ordinal 3) with
        // a nullable REFERENCE element that even carries the ALLOCATION_DEPENDENCY
        // field flag. For an ARRAY, gcAllocationDependencies consults the
        // CONSTRUCTOR kind, NOT the element's dependency flag — and ArrayGeneric
        // adds no snapshot dependency. So a generic array has no constructor deps,
        // even over a reference element. Mutation guard against consulting the
        // array element's ALLOCATION_DEPENDENCY flag like a struct field.
        let map = codec_map(0);
        let nodes = vec![
            array_node(0, 0, 3, 4, vec![1]),
            entry(1, ReferenceRecipeNode::Externref { handle: 7 }),
        ];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert!(hints.allocation_dependencies(0).is_empty());
    }

    #[test]
    fn array_new_provenance_edge_is_the_dependency() {
        // Fixture layout 7 is `array.new` (ArrayNew, type ordinal 3, provenance
        // ref count 1). gcAllocationDependencies takes the ONE provenance edge
        // (prov != 0), so the ArrayNew snapshot arm does NOT fire; the single
        // dependency is the provenance edge (edge 0).
        let map = codec_map(0);
        let nodes = vec![
            array_node(0, 0, 3, 7, vec![1]),
            entry(1, ReferenceRecipeNode::Externref { handle: 7 }),
        ];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert_eq!(hints.allocation_dependencies(0), &[1]);
    }

    // -- Direct unit tests of the gcAllocationDependencies array arms ----------
    //
    // The committed fixture has no reference-element ArrayFixed/ArrayNew-with-
    // snapshot layout, so exercise those arms by constructing the layout
    // descriptor directly (its fields are public) and calling the port. This
    // pins the array constructor-dependency behavior field-for-field.

    fn ref_element(alloc_dep: bool) -> crate::gc_codec::GcFieldDescriptor {
        let mut flags = FIELD_FLAG_REFERENCE | F_NULLABLE;
        if alloc_dep {
            flags |= FIELD_FLAG_ALLOCATION_DEPENDENCY;
        }
        crate::gc_codec::GcFieldDescriptor {
            storage: STORAGE_REF,
            flags,
            scalar_offset: None,
            reference_ordinal: Some(0),
        }
    }

    fn array_layout(
        constructor: u8,
        provenance_reference_count: u32,
        element: crate::gc_codec::GcFieldDescriptor,
    ) -> GcLayoutDescriptor {
        GcLayoutDescriptor {
            id: 1,
            type_ordinal: 0,
            kind: KIND_ARRAY,
            constructor,
            flags: 0,
            scalar_length_or_stride: 0,
            fields: vec![element],
            super_type_ordinal: None,
            base_layout_id: 1,
            auxiliary: 0,
            provenance_reference_count,
            provenance_scalar_length: 0,
        }
    }

    #[test]
    fn array_fixed_snapshot_elements_are_all_dependencies() {
        // ArrayFixed with a reference element and NO provenance: every snapshot
        // element is an allocation dependency (`dependencies.push(...snapshot)`).
        let layout = array_layout(CONSTRUCTOR_ARRAY_FIXED, 0, ref_element(false));
        let deps = gc_allocation_dependencies(&[10, 11, 12], false, &layout).unwrap();
        assert_eq!(deps, vec![10, 11, 12]);
    }

    #[test]
    fn array_fixed_with_provenance_takes_only_provenance() {
        // ArrayFixed with provenance refs: only the provenance edges are deps (the
        // `provenanceReferenceCount === 0` guard blocks the snapshot push).
        let layout = array_layout(CONSTRUCTOR_ARRAY_FIXED, 2, ref_element(false));
        let deps = gc_allocation_dependencies(&[10, 11, 12], false, &layout).unwrap();
        assert_eq!(deps, vec![10, 11]);
    }

    #[test]
    fn array_new_first_snapshot_element_is_the_dependency_when_no_provenance() {
        // ArrayNew with NO provenance and a nonempty snapshot: ONLY the FIRST
        // snapshot element is a dependency.
        let layout = array_layout(CONSTRUCTOR_ARRAY_NEW, 0, ref_element(false));
        let deps = gc_allocation_dependencies(&[10, 11, 12], false, &layout).unwrap();
        assert_eq!(deps, vec![10]);
    }

    #[test]
    fn non_reference_element_array_has_no_reference_dependencies() {
        // A non-reference element array returns only its provenance edges; the
        // constructor arms never run.
        let mut element = ref_element(false);
        element.storage = STORAGE_I32;
        element.flags = F_MUTABLE; // clears the REFERENCE bit
        let layout = array_layout(CONSTRUCTOR_ARRAY_FIXED, 0, element);
        let deps = gc_allocation_dependencies(&[10, 11], false, &layout).unwrap();
        assert!(deps.is_empty());
    }

    #[test]
    fn i31_owner_is_the_smallest_gc_declaring_activation() {
        // Two activations with catalogs (3 and 7): i31Owner is the smaller, 3.
        let mut map = BTreeMap::new();
        map.insert(7u32, decode_gc_codec(TS_FIXTURE).unwrap());
        map.insert(3u32, decode_gc_codec(TS_FIXTURE).unwrap());
        let nodes = vec![entry(0, ReferenceRecipeNode::I31 { value: -5 })];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert_eq!(hints.i31_owner(), Some(3));

        let plan = build_drive_plan(&nodes, &hints).unwrap();
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![(DRIVE_OP_ALLOC, drive_table_base(3) + DRIVE_OP_ALLOC, 0)]
        );
    }

    #[test]
    fn i31_owner_is_none_without_a_gc_activation() {
        let map: BTreeMap<u32, GcCodec> = BTreeMap::new();
        let nodes = vec![entry(0, ReferenceRecipeNode::I31 { value: 1 })];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert_eq!(hints.i31_owner(), None);
        // No i31 owner -> the builder fails loudly (mirrors the JS `!`).
        assert_eq!(build_drive_plan(&nodes, &hints), Err(Errno::EINVAL));
    }

    #[test]
    fn exn_owner_is_the_module_activation_for_a_program_exception() {
        // A program (non-host) exnref owns itself: directOwner == module_activation.
        let map = codec_map(0);
        let nodes = vec![
            entry(0, ReferenceRecipeNode::Externref { handle: 8 }),
            entry(
                1,
                ReferenceRecipeNode::Exnref {
                    module_activation: 4,
                    tag_ordinal: 0,
                    layout_id: 0,
                    scalars: Vec::new(),
                    payloads: vec![0],
                },
            ),
        ];
        let hints = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert_eq!(hints.exn_owner(1), Some(4));
        let plan = build_drive_plan(&nodes, &hints).unwrap();
        // The reachable payload externref (recipe 0) is published into the transit
        // first, then the exnref materializes in its owner activation (4).
        assert_eq!(
            plan.iter().map(triple).collect::<Vec<_>>(),
            vec![
                (DRIVE_OP_EXTERNREF_TRANSIT, 0, 0),
                (DRIVE_OP_EXN, drive_table_base(4) + DRIVE_OP_EXN, 1),
            ]
        );
    }

    #[test]
    fn host_exception_exnref_remaps_to_the_host_exception_owner() {
        // A host exnref (module_activation == FORK_HOST_EXCEPTION_ACTIVATION_ID)
        // remaps to the supplied hostExceptionOwner (here activation 2).
        let map = codec_map(0);
        let nodes = vec![
            entry(0, ReferenceRecipeNode::Externref { handle: 8 }),
            entry(
                1,
                ReferenceRecipeNode::Exnref {
                    module_activation: FORK_HOST_EXCEPTION_ACTIVATION_ID,
                    tag_ordinal: 0,
                    layout_id: 0,
                    scalars: Vec::new(),
                    payloads: vec![0],
                },
            ),
        ];
        let hints = GcCodecHints::new(&nodes, &map, Some(2)).unwrap();
        assert_eq!(hints.exn_owner(1), Some(2));
        // Without a host-exception owner the entry is absent -> None -> EINVAL.
        let hints_none = GcCodecHints::new(&nodes, &map, None).unwrap();
        assert_eq!(hints_none.exn_owner(1), None);
        assert_eq!(build_drive_plan(&nodes, &hints_none), Err(Errno::EINVAL));
    }

    #[test]
    fn struct_recipe_without_a_seeded_catalog_is_einval() {
        // A struct whose owning activation has no seeded catalog fails loudly (the
        // JS "no GC descriptor" throw).
        let map: BTreeMap<u32, GcCodec> = BTreeMap::new();
        let nodes = vec![struct_node(0, 0, 0, 1, vec![])];
        assert_eq!(GcCodecHints::new(&nodes, &map, None), Err(Errno::EINVAL));
    }

    #[test]
    fn struct_recipe_with_wrong_coordinate_is_einval() {
        // layout_id 1 has type ordinal 0; a recipe claiming type ordinal 9 is a
        // mismatched coordinate (the JS validateGcRecipe throw).
        let map = codec_map(0);
        let nodes = vec![struct_node(0, 0, 9, 1, vec![1, 1])];
        assert_eq!(GcCodecHints::new(&nodes, &map, None), Err(Errno::EINVAL));
    }

    #[test]
    fn unknown_layout_id_is_einval() {
        // layout_id 99 is not in the seven-layout catalog.
        let map = codec_map(0);
        let nodes = vec![struct_node(0, 0, 0, 99, vec![])];
        assert_eq!(GcCodecHints::new(&nodes, &map, None), Err(Errno::EINVAL));
    }
}
