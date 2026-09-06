/*
 * checkpoint-dlopen-lib.c — side module for examples/checkpoint-dlopen.c.
 *
 * Loading it is the whole point: the load advances the process's
 * dynamic-loader archive generation and leaves every thread that did not do it
 * one generation behind. Nothing calls what is in here.
 */
#include "abi_constants.h"

__attribute__((export_name("__abi_version")))
unsigned __abi_version(void) {
	return WASM_POSIX_ABI_VERSION;
}

int foo(void) {
	return 42;
}
