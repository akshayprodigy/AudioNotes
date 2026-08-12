/* Compiled as C. The assertion under test is the header itself:
 * if this file compiles and links, the ABI boundary is C-clean. The runtime check just
 * exercises the error path (bogus model) without needing model files. */
#include "capi/audionotes_capi.h"

#include <stdio.h>
#include <string.h>

int main(void) {
  an_options opts;
  memset(&opts, 0, sizeof opts);
  opts.pcm_path = "/nonexistent.pcm";
  opts.asr_model = "/nonexistent.bin";
  an_result* r = an_process(&opts, NULL, NULL);
  if (!r) { fprintf(stderr, "an_process returned NULL\n"); return 1; }
  if (!an_result_error(r)) { fprintf(stderr, "expected an error for bogus models\n"); return 1; }
  if (!an_result_json(r)) { fprintf(stderr, "json must be non-NULL even on error\n"); return 1; }
  an_result_free(r);
  printf("test_capi OK\n");
  return 0;
}
