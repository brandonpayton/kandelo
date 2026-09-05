//! Native Wasmtime backend for [`ForkHostCapabilities`] (N1-I5 Task 2).
//!
//! `crates/fork-codec/src/host_capabilities.rs` defines the engine-floor
//! seam — the three tag-identity primitives Wasm genuinely cannot express
//! (`mint_exception_tag`, `provide_unwind_transport_tag`,
//! `recognize_unwind_transport`). `crates/fork-codec/src/native_sketch.rs` is
//! a DESIGN-ARTIFACT sketch of what a native impl would look like, gated
//! behind the `native-sketch` feature and adding NO `wasmtime` dependency
//! (every body is `Err(Errno::ENOSYS)`) — `fork-codec` is `no_std` and must
//! never depend on `wasmtime`, so that sketch can never become the real
//! backend in-place. This module is the real backend: it lives in
//! `host-native` (a `std` crate that already depends on `wasmtime`) and
//! implements the exact same trait against a real `wasmtime::Store`.
//!
//! # Scope (grounding doc §3, `docs/plans/2026-09-05-n1-i5-references-
//! grounding.md`)
//!
//! None of these three methods sits on the funcref/externref/GC
//! reference-replay hot path the co-resident fork-module drives — they are
//! unwind-transport and future native-exception plumbing. Per the trait's own
//! doc comments:
//!
//!   * `mint_exception_tag` stays inert on the Wasm/exnref path through
//!     D6.3a — a program exception tag is guest-module-local, so the
//!     module's own drive step never calls this. It exists for a native
//!     backend that mints its own program-exception tags, which nothing in
//!     this crate does yet.
//!   * `provide_unwind_transport_tag` backs a PROCESS-WIDE tag shared by
//!     every co-resident module in a worker. `crate::guest`'s existing N1-I4
//!     unwind path (the `env.__wpk_fork_unwind` tag wired at
//!     `spawn_guest_thread`'s fork-module-instantiation call site) mints its
//!     own tag directly via `wasmtime::Tag::new`, and that tag is
//!     documented there as the guest's OWN PRIVATE unwind-transport tag, not
//!     a process-wide one — so this method is NOT wired into that call site
//!     (see this module's tests for why: `wasmtime::Tag` is
//!     `Store`-scoped — `Tag::eq`/`Tag::new` operate against one
//!     `Store` — and `host-native` creates a fresh `Store<()>` per guest OS
//!     thread, so a literal cross-guest "process-wide" tag has no native
//!     analog without a much larger architecture change than this task's
//!     scope. Left real-but-unexercised, as the task brief allows.)
//!   * `recognize_unwind_transport`'s own doc comment says its caller wiring
//!     is deferred to "the later unwind/exec slice" and does NOT land with
//!     D6.3a.
//!
//! So this module makes the three methods genuinely correct against
//! Wasmtime — real `Tag::new`/`Tag::eq` calls, not stubs — without wiring any
//! call site to invoke them yet. I5's reference-replay acceptance bar does
//! not depend on them firing (see the trait's own module doc comment).

use std::collections::HashMap;

use wasmtime::{FuncType, Store, Tag, TagType};

use fork_codec::host_capabilities::{ForkHostCapabilities, HostGeneration, HostRef, HostTag};
use wasm_posix_shared::Errno;

/// Native `ForkHostCapabilities` backend: a thin `wasmtime::Tag` side table
/// keyed by the same opaque `u32` seam the trait's `HostTag`/`HostRef`
/// newtypes define (mirrors `native_sketch.rs`'s documented "the backend
/// holds `Tag` DIRECTLY in its own `HashMap<u32, _>`" design, made real).
///
/// Borrows the `Store` for its lifetime because none of the trait's methods
/// take a store parameter — the implementing type must supply one. A fresh
/// `NativeForkHostCapabilities` is expected to be constructed per guest OS
/// thread (mirroring [`crate::guest::instantiate_fork_module`]'s
/// per-thread `ExternrefRegistry`), so `provide_unwind_transport_tag`'s
/// "idempotent for the worker's life" contract holds relative to whatever
/// scope owns one instance of this type — see this module's doc comment for
/// why that scope does not span more than one guest `Store` today.
pub struct NativeForkHostCapabilities<'store> {
    store: &'store mut Store<()>,
    /// `HostTag` ordinal -> the real `Tag` it names. `0` is the reserved
    /// "none" ordinal (per `host_capabilities.rs`'s opaque-handle-model doc
    /// comment), so ordinals here start at `1`.
    tags: HashMap<u32, Tag>,
    next_tag_ordinal: u32,
    /// Cached ordinal for the single process-wide (per-instance-of-this-type)
    /// unwind-transport tag `provide_unwind_transport_tag` mints once.
    unwind_transport_tag: Option<u32>,
    /// `(module_activation, layout_id) -> HostTag` ordinal, so repeat asks
    /// for the same activation's exception layout mint exactly one `Tag`.
    exception_tags: HashMap<(u32, u32), u32>,
    /// `HostRef` ordinal -> the `Tag` of the reconstructed reference value it
    /// names. Nothing in this crate populates this yet — see
    /// `recognize_unwind_transport`'s doc comment — so lookups against it
    /// return the trait's own documented "unknown handle" failure
    /// (`Errno::EINVAL`) until a caller starts registering into it.
    ref_tags: HashMap<u32, Tag>,
}

impl<'store> NativeForkHostCapabilities<'store> {
    /// Borrow `store` for the life of this capabilities handle.
    pub fn new(store: &'store mut Store<()>) -> Self {
        Self {
            store,
            tags: HashMap::new(),
            next_tag_ordinal: 1,
            unwind_transport_tag: None,
            exception_tags: HashMap::new(),
            ref_tags: HashMap::new(),
        }
    }

    fn alloc_tag(&mut self, tag: Tag) -> HostTag {
        let ordinal = self.next_tag_ordinal;
        self.next_tag_ordinal += 1;
        self.tags.insert(ordinal, tag);
        HostTag(ordinal)
    }

    /// Register `tag` as the `Tag` backing reconstructed reference value
    /// `r`, so a future `recognize_unwind_transport(_, r)` can resolve it.
    /// Exposed for forward-compatible wiring and this module's own tests;
    /// nothing in this crate calls it yet (see this module's doc comment).
    pub fn register_ref_tag(&mut self, r: HostRef, tag: Tag) {
        self.ref_tags.insert(r.0, tag);
    }
}

impl ForkHostCapabilities for NativeForkHostCapabilities<'_> {
    fn mint_exception_tag(
        &mut self,
        _generation: HostGeneration,
        module_activation: u32,
        layout_id: u32,
    ) -> Result<HostTag, Errno> {
        let key = (module_activation, layout_id);
        if let Some(&ordinal) = self.exception_tags.get(&key) {
            return Ok(HostTag(ordinal));
        }
        // No exception-layout catalog exists in `host-native` yet (that is
        // D6.3a/GC-exception-codec territory, well beyond this task) to
        // supply this tag's real parameter types, so this mints a tag with
        // no declared params until one does. Real, idempotent per
        // `(module_activation, layout_id)`, and consistent with this
        // method's own doc comment ("STAYS INERT on the Wasm/exnref path
        // through D6.3a") — nothing calls this yet, so the empty-params
        // default never observes a real program's exception layout.
        let ty = FuncType::new(self.store.engine(), [], []);
        let tag = Tag::new(&mut *self.store, &TagType::new(ty)).map_err(|_| Errno::ENOMEM)?;
        let host_tag = self.alloc_tag(tag);
        self.exception_tags.insert(key, host_tag.0);
        Ok(host_tag)
    }

    fn provide_unwind_transport_tag(&mut self) -> Result<HostTag, Errno> {
        if let Some(ordinal) = self.unwind_transport_tag {
            return Ok(HostTag(ordinal));
        }
        let ty = FuncType::new(self.store.engine(), [], []);
        let tag = Tag::new(&mut *self.store, &TagType::new(ty)).map_err(|_| Errno::ENOMEM)?;
        let host_tag = self.alloc_tag(tag);
        self.unwind_transport_tag = Some(host_tag.0);
        Ok(host_tag)
    }

    fn recognize_unwind_transport(
        &mut self,
        tag: HostTag,
        candidate: HostRef,
    ) -> Result<bool, Errno> {
        let transport = *self.tags.get(&tag.0).ok_or(Errno::EINVAL)?;
        let candidate_tag = *self.ref_tags.get(&candidate.0).ok_or(Errno::EINVAL)?;
        Ok(Tag::eq(&candidate_tag, &transport, &*self.store))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (wasmtime::Engine, Store<()>) {
        let engine = crate::kernel_engine().expect("engine");
        let store = Store::new(&engine, ());
        (engine, store)
    }

    #[test]
    fn mint_exception_tag_is_idempotent_per_activation_and_layout() {
        let (_engine, mut store) = store();
        let mut caps = NativeForkHostCapabilities::new(&mut store);

        let first = caps.mint_exception_tag(HostGeneration(1), 0, 7).unwrap();
        let second = caps.mint_exception_tag(HostGeneration(1), 0, 7).unwrap();
        assert_eq!(
            first, second,
            "same (activation, layout_id) must mint exactly one Tag"
        );

        let other = caps.mint_exception_tag(HostGeneration(1), 0, 8).unwrap();
        assert_ne!(
            first, other,
            "a different layout_id must mint a different Tag"
        );
    }

    #[test]
    fn provide_unwind_transport_tag_is_idempotent_for_the_lifetime() {
        let (_engine, mut store) = store();
        let mut caps = NativeForkHostCapabilities::new(&mut store);

        let first = caps.provide_unwind_transport_tag().unwrap();
        let second = caps.provide_unwind_transport_tag().unwrap();
        assert_eq!(
            first, second,
            "the transport tag must be minted exactly once"
        );
    }

    #[test]
    fn recognize_unwind_transport_compares_real_tag_identity() {
        let (engine, mut store) = store();
        let mut caps = NativeForkHostCapabilities::new(&mut store);

        let transport = caps.provide_unwind_transport_tag().unwrap();
        let program_tag = caps.mint_exception_tag(HostGeneration(1), 0, 1).unwrap();

        // Register two candidate HostRefs: one whose real Tag genuinely is
        // the transport tag (minted via the same path a caught unwind
        // exception's tag would be), one whose real Tag is an unrelated
        // program exception tag.
        let transport_real_tag = *caps.tags.get(&transport.0).unwrap();
        let program_real_tag = *caps.tags.get(&program_tag.0).unwrap();
        caps.register_ref_tag(HostRef(100), transport_real_tag);
        caps.register_ref_tag(HostRef(101), program_real_tag);

        assert!(
            caps.recognize_unwind_transport(transport, HostRef(100))
                .unwrap(),
            "a candidate carrying the transport tag must be recognized"
        );
        assert!(
            !caps
                .recognize_unwind_transport(transport, HostRef(101))
                .unwrap(),
            "a candidate carrying an unrelated tag must not be recognized"
        );

        // An unregistered HostRef is a truthful EINVAL, not a silent `false`.
        let err = caps
            .recognize_unwind_transport(transport, HostRef(999))
            .unwrap_err();
        assert_eq!(err, Errno::EINVAL);

        drop(engine);
    }
}
