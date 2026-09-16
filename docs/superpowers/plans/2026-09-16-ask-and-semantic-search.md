# Ask This Meeting and Semantic Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Pro user can search their library by meaning and ask one meeting a question that is answered from, and cites, its own transcript — offline.

**Architecture:** A 37 MB embedding model (`bge-small-en-v1.5`, q8_0 GGUF) runs through the llama.cpp already in the app (`EmbedEngine`, C++). Each processed meeting's transcript is chunked into ≤100-word windows and embedded into `search_vec` (int8 + scale, Kotlin `VecCodec`) by a new `EMBED` stage and a sweep-driven backfill. Search fuses FTS5 and cosine hits by reciprocal rank (`Retriever`). Ask retrieves the meeting's top eight chunks, builds a fenced numbered prompt in C++ (`askPrompt`), generates with the resident writer, validates citations in C++ (`validateAnswer`), stores the exchange in `asks`, and `AskScreen` shows the thread with tappable citations.

**Tech Stack:** llama.cpp embeddings API (`llama_get_embeddings_seq`), Kotlin (AudioDb/SQLCipher, ProcessingEngine, StorageModule/LlmModule), RN 0.86 TypeScript screens, JUnit + jest + C++ `CHECK` tests, `scripts/mutate-*.py` house rule.

**Conventions this plan assumes** (read once): the Kotlin schema is `AudioDb.SCHEMA` + `ADDED_COLUMNS` mirrored by `src/db/schema.ts` and pinned by `SchemaTest.kt` / `schema.test.ts`; every prompt is built in C++ through `cpp/minutes/fence.h` and `scripts/check-prompt-fencing.py` scans for it; C++ tests use a `CHECK` macro (the target is Release; `assert` compiles away); Kotlin unit tests run with `cd android && ./gradlew :app:testDebugUnitTest --tests '*Name*'` and the result is read from `app/build/test-results/testDebugUnitTest/TEST-*.xml` (BUILD SUCCESSFUL alone is not proof the test ran); jest with `npx jest <file> --forceExit`; the Mac C++ build is `cmake --build cpp/cli/build && (cd cpp/cli/build && ctest --output-on-failure)` with `CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake`. Every new test is mutation-checked before its commit: break the implementation on purpose, watch the test fail, restore — in the foreground, never with a background restore.

---

### Task 1: The embedding model in the catalog

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/ModelCatalog.kt` (after the `llm-qwen` `ModelSpec`)
- Test: `android/app/src/test/java/com/innocorelabs/verbale/data/ModelCatalogTest.kt`

- [ ] **Step 1: Failing test** — append to `ModelCatalogTest`:

```kotlin
  /**
   * The embedding model rides with the writer: same kind, so the paid gate, the onboarding
   * switch and the trial download all carry it without a second list of "what Pro fetches".
   */
  @Test fun theEmbeddingModelIsPartOfTheWriterBundle() {
    val e = ModelCatalog.byId("embed-bge-small") ?: error("embed-bge-small is not catalogued")
    assertEquals("llm", e.kind)
    assertFalse(e.required)
    assertTrue(ModelCatalog.needsSubscription(e))
    assertEquals("bge-small-en-v1.5-q8_0.gguf", e.filename)
    assertEquals(36_806_944L, e.sizeBytes)
    assertEquals("ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514", e.parts.single().sha256)
  }
```

- [ ] **Step 2: Run** `cd android && ./gradlew :app:testDebugUnitTest --tests '*ModelCatalogTest*'` → FAILS (`embed-bge-small is not catalogued`).

- [ ] **Step 3: Implement** — after the `llm-qwen` spec in `ModelCatalog.ALL`:

```kotlin
    // The embedding model behind meaning search and Ask. BAAI bge-small-en-v1.5 (MIT), 33 M
    // parameters, 384 dimensions, English — the launch language. q8_0 from CompendiumLabs'
    // GGUF conversion; runs through the same llama.cpp as the writer.
    //
    // kind = "llm" on purpose, though it writes nothing: everything that gates, offers and
    // downloads "the writer" keys on that kind (needsSubscription, the onboarding switch, the
    // trial's download loop), and this model is useless without the writer and vice versa. One
    // bundle, one rule, no second list to drift.
    ModelSpec(
      "embed-bge-small", "Meaning index",
      "Finds what was meant, not only the words said", "Without it search matches words only, and the meeting cannot be asked.",
      "llm", false, "bge-small-en-v1.5-q8_0.gguf",
      "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
      "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514", 36_806_944L,
    ),
```

Then `grep -n "llm-qwen" android/app/src/main/java/com/innocorelabs/verbale/pipeline/*.kt src/**/*.ts*` — every place that means *the writer* keeps `"llm-qwen"`; nothing should select "the llm" by kind expecting one file (`PaywallScreen.onStartTrial` loops over all `kind === 'llm'` — correct, it should now fetch both).

- [ ] **Step 4: Run** the test → passes. Also `npx jest src/billing` (PRO_MODEL_IDS is unaffected: the kind rule comes from native).

- [ ] **Step 5: Fetch the file for the Mac tests** (not committed; 37 MB):

```bash
mkdir -p ~/.cache/verbale-models && curl -L -o ~/.cache/verbale-models/bge-small-en-v1.5-q8_0.gguf \
  https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf
shasum -a 256 ~/.cache/verbale-models/bge-small-en-v1.5-q8_0.gguf   # ec38e8da…
```

- [ ] **Step 6: Commit** — `git commit -m "feat(search): the embedding model joins the writer bundle"`

---

### Task 2: `EmbedEngine` (C++) and its Mac test

**Files:**
- Create: `cpp/llm/embed_engine.h`, `cpp/llm/embed_engine.cpp`
- Create: `cpp/tests/test_embed.cpp`
- Modify: `cpp/CMakeLists.txt` (add `llm/embed_engine.cpp` next to `llm/llama_engine.cpp`), `cpp/cli/CMakeLists.txt` (register `test_embed`)

- [ ] **Step 1: Failing test** — `cpp/tests/test_embed.cpp`:

```cpp
// The embedding engine, against the real model on the Mac. Skipped — with a printed reason,
// exit 0 — when VERBALE_EMBED_GGUF is unset or missing, so the gate passes on a machine without
// the file and fails loudly on one with it.
#include "llm/embed_engine.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace audionotes;

static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

static float dot(const std::vector<float>& a, const std::vector<float>& b) {
  float s = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); ++i) s += a[i] * b[i];
  return s;
}

int main() {
  const char* path = std::getenv("VERBALE_EMBED_GGUF");
  if (!path || !*path) {
    std::puts("test_embed: skipped (VERBALE_EMBED_GGUF unset)");
    return 0;
  }
  EmbedEngine e;
  if (!e.load(path, 4)) {
    std::fprintf(stderr, "test_embed: could not load %s\n", path);
    return 1;
  }
  CHECK(e.dim() == 384);

  const auto v = e.embed({"the proposal is due on Friday", "when do we deliver the pitch",
                          "the coffee machine is broken"});
  CHECK(v.size() == 3);
  for (const auto& x : v) {
    CHECK(x.size() == 384);
    CHECK(std::fabs(dot(x, x) - 1.0f) < 1e-3f);  // unit length
  }
  const float near = dot(v[0], v[1]);
  const float far = dot(v[0], v[2]);
  std::printf("test_embed: near=%.3f far=%.3f\n", near, far);
  CHECK(near > far + 0.1f);

  // Deterministic: the same text embeds to the same vector.
  const auto again = e.embed({"the proposal is due on Friday"});
  CHECK(again.size() == 1 && std::fabs(dot(again[0], v[0]) - 1.0f) < 1e-4f);

  // Empty input is not an error; an empty string still yields a vector.
  CHECK(e.embed({}).empty());
  CHECK(e.embed({""}).size() == 1);

  if (failures) {
    std::fprintf(stderr, "test_embed: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_embed: ok");
  return 0;
}
```

- [ ] **Step 2: Header** — `cpp/llm/embed_engine.h`:

```cpp
// Sentence embeddings over llama.cpp (a BERT-family GGUF such as bge-small-en-v1.5). The model
// is loaded once and reused; every call is independent. Used by meaning search and by Ask's
// retrieval. Vectors come back L2-normalised, so a dot product is a cosine.
#pragma once
#include <string>
#include <vector>

namespace audionotes {

class EmbedEngine {
 public:
  EmbedEngine();
  ~EmbedEngine();

  // n_ctx is fixed at 512 — bge's own limit. Texts longer than that are truncated at the
  // tokenizer, never refused: a chunk is ≤ 100 words by construction (SearchChunker), so this
  // only guards a hand-typed question.
  bool load(const std::string& model_path, int n_threads);
  bool ok() const;
  int dim() const;

  // One vector per text, in order. Empty input → empty output; an empty text still embeds.
  std::vector<std::vector<float>> embed(const std::vector<std::string>& texts);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
```

- [ ] **Step 3: Implementation** — `cpp/llm/embed_engine.cpp`:

```cpp
#include "llm/embed_engine.h"

#include <cmath>
#include <cstdio>

#ifdef HAVE_LLAMA
#include "llama.h"
#endif

namespace audionotes {

namespace {
constexpr int kCtx = 512;
}

struct EmbedEngine::Impl {
  bool ready = false;
  int n_embd = 0;
#ifdef HAVE_LLAMA
  llama_model* model = nullptr;
  llama_context* ctx = nullptr;
  const llama_vocab* vocab = nullptr;

  bool load(const std::string& path, int n_threads) {
    llama_backend_init();
    llama_model_params mparams = llama_model_default_params();
    model = llama_model_load_from_file(path.c_str(), mparams);
    if (!model) return false;
    vocab = llama_model_get_vocab(model);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = kCtx;
    // Non-causal (BERT) attention needs the physical batch equal to the logical one: the whole
    // text is one forward pass. Pooling comes from the GGUF (CLS for bge, mean for MiniLM).
    cparams.n_batch = kCtx;
    cparams.n_ubatch = kCtx;
    cparams.n_threads = n_threads;
    cparams.n_threads_batch = n_threads;
    cparams.embeddings = true;
    cparams.pooling_type = LLAMA_POOLING_TYPE_UNSPECIFIED;
    ctx = llama_init_from_model(model, cparams);
    if (!ctx) return false;
    if (llama_pooling_type(ctx) == LLAMA_POOLING_TYPE_NONE) {
      std::fprintf(stderr, "embed: model declares no pooling; refusing to guess\n");
      return false;
    }
    n_embd = llama_model_n_embd(model);
    ready = n_embd > 0;
    return ready;
  }

  std::vector<float> one(const std::string& text) {
    // Tokenize with the special tokens bge expects ([CLS] … [SEP]); truncate at n_ctx.
    std::vector<llama_token> toks(kCtx);
    int n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), toks.data(),
                           kCtx, /*add_special=*/true, /*parse_special=*/false);
    if (n < 0) n = kCtx;  // longer than the context: the tokenizer wrote the first kCtx
    if (n == 0) n = 1;    // an empty text still gets [CLS] alone
    toks.resize(static_cast<size_t>(n));

    llama_batch batch = llama_batch_init(n, 0, 1);
    for (int i = 0; i < n; ++i) {
      batch.token[i] = toks[static_cast<size_t>(i)];
      batch.pos[i] = i;
      batch.n_seq_id[i] = 1;
      batch.seq_id[i][0] = 0;
      batch.logits[i] = 1;
    }
    batch.n_tokens = n;
    llama_memory_clear(llama_get_memory(ctx), true);
    std::vector<float> out;
    if (llama_decode(ctx, batch) == 0) {
      const float* e = llama_get_embeddings_seq(ctx, 0);
      if (e) {
        out.assign(e, e + n_embd);
        float norm = 0;
        for (float x : out) norm += x * x;
        norm = std::sqrt(norm);
        if (norm > 0) for (float& x : out) x /= norm;
      }
    }
    llama_batch_free(batch);
    return out;
  }

  ~Impl() {
    if (ctx) llama_free(ctx);
    if (model) llama_model_free(model);
  }
#else
  bool load(const std::string&, int) { return false; }
  std::vector<float> one(const std::string&) { return {}; }
#endif
};

EmbedEngine::EmbedEngine() : impl_(new Impl()) {}
EmbedEngine::~EmbedEngine() { delete impl_; }

bool EmbedEngine::load(const std::string& model_path, int n_threads) {
  return impl_->load(model_path, n_threads);
}
bool EmbedEngine::ok() const { return impl_->ready; }
int EmbedEngine::dim() const { return impl_->n_embd; }

std::vector<std::vector<float>> EmbedEngine::embed(const std::vector<std::string>& texts) {
  std::vector<std::vector<float>> out;
  if (!impl_->ready) return out;
  out.reserve(texts.size());
  for (const auto& t : texts) out.push_back(impl_->one(t));
  return out;
}

}  // namespace audionotes
```

- [ ] **Step 4: CMake** — in `cpp/CMakeLists.txt` add `llm/embed_engine.cpp` beside `llm/llama_engine.cpp` in the `audionotes` sources. In `cpp/cli/CMakeLists.txt`, next to `test_evidence_record`:

```cmake
audionotes_add_test(test_embed ${CORE}/tests/test_embed.cpp)
target_compile_definitions(test_embed PRIVATE HAVE_LLAMA=1)
```

(Check how `test_evidence_record` is registered and copy its link line exactly — the test needs the `audionotes` library and llama.)

- [ ] **Step 5: Build and run**

```bash
CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake
$CMAKE --build cpp/cli/build -j 8 && (cd cpp/cli/build && VERBALE_EMBED_GGUF=$HOME/.cache/verbale-models/bge-small-en-v1.5-q8_0.gguf ./test_embed)
```

Expected: `test_embed: near=0.7xx far=0.3xx` and `ok`. If `near > far + 0.1` fails, print all three vectors' pairwise dots and check pooling (`llama_pooling_type(ctx)` should be CLS = 2 for bge). Then `ctest` without the variable → "skipped".

- [ ] **Step 6: Mutation-check** — make `one()` skip the normalisation → the unit-length check fails; return `v[2]`'s text for every input (embed the first text only) → `near > far` fails. Restore.

- [ ] **Step 7: Commit** — `git commit -m "feat(search): EmbedEngine — sentence vectors over llama.cpp, tested against the real model"`

---

### Task 3: JNI and the Kotlin runtime holder

**Files:**
- Modify: `cpp/jni/audionotes_jni.cpp` (after `nativeLlmFree`), `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt`
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/EmbedRuntime.kt`

- [ ] **Step 1: JNI** — add to `audionotes_jni.cpp` (include `"llm/embed_engine.h"` at the top with the other llm include):

```cpp
// ---- Embeddings (bge-small over llama.cpp) --------------------------------------------------
extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedLoad(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jint nThreads) {
  const std::string path = jstr(env, jModelPath);
  auto* engine = new audionotes::EmbedEngine();
  if (!engine->load(path, static_cast<int>(nThreads))) {
    delete engine;
    return 0;
  }
  return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedDim(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* engine = reinterpret_cast<audionotes::EmbedEngine*>(handle);
  return engine ? engine->dim() : 0;
}

// Flat: dim * n floats, text i at [i*dim, (i+1)*dim). A text that failed to embed is all zeros,
// so a caller can tell (a unit vector is never zero) without a second array of flags.
extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedTexts(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jobjectArray jTexts) {
  auto* engine = reinterpret_cast<audionotes::EmbedEngine*>(handle);
  const std::vector<std::string> texts = jstrArray(env, jTexts);
  const int dim = engine ? engine->dim() : 0;
  std::vector<float> flat(static_cast<size_t>(dim) * texts.size(), 0.0f);
  if (engine && dim > 0) {
    const auto vecs = engine->embed(texts);
    for (size_t i = 0; i < vecs.size(); ++i) {
      if (vecs[i].size() == static_cast<size_t>(dim)) {
        std::copy(vecs[i].begin(), vecs[i].end(), flat.begin() + static_cast<long>(i) * dim);
      }
    }
  }
  jfloatArray out = env->NewFloatArray(static_cast<jsize>(flat.size()));
  if (out && !flat.empty()) env->SetFloatArrayRegion(out, 0, static_cast<jsize>(flat.size()), flat.data());
  return out;
}

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedFree(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  delete reinterpret_cast<audionotes::EmbedEngine*>(handle);
}
```

- [ ] **Step 2: NativeBridge externs** — after `nativeLlmFree`:

```kotlin
  // ---- Embeddings: meaning search and Ask's retrieval. Same load/use/free shape as the LLM. ----
  external fun nativeEmbedLoad(modelPath: String, nThreads: Int): Long
  external fun nativeEmbedDim(handle: Long): Int
  /** Flat `dim * texts.size` floats, unit vectors; an all-zero row is a text that failed. */
  external fun nativeEmbedTexts(handle: Long, texts: Array<String>): FloatArray
  external fun nativeEmbedFree(handle: Long)
```

- [ ] **Step 3: The holder** — `EmbedRuntime.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.ModelCatalog

/**
 * The one embedding model handle in the process. 37 MB resident is cheap and loading is ~100 ms,
 * so it is loaded on first use and kept until memory pressure or an explicit release; every
 * caller — the EMBED stage, the backfill, search, Ask — shares it under one lock, because
 * llama contexts are not re-entrant.
 *
 * `available` is the whole gate: entitled AND the file on disk. A lapsed subscriber keeps the
 * weights and loses the use of them, exactly like the writer.
 */
object EmbedRuntime {
  private const val TAG = "Embed"
  const val MODEL_ID = "embed-bge-small"
  private val lock = Any()
  @Volatile private var handle = 0L

  fun modelFile(ctx: Context) = ModelCatalog.fileFor(ctx, MODEL_ID)?.takeIf { it.exists() && it.length() > 0 }

  fun available(ctx: Context): Boolean = LicenceStore.entitled(ctx) && modelFile(ctx) != null

  /** Unit vectors, one per text, or null when the model cannot be used. */
  fun embed(ctx: Context, texts: List<String>): List<FloatArray>? {
    if (texts.isEmpty()) return emptyList()
    synchronized(lock) {
      val h = ensureLoaded(ctx) ?: return null
      val dim = NativeBridge.nativeEmbedDim(h)
      val flat = NativeBridge.nativeEmbedTexts(h, texts.toTypedArray())
      if (dim <= 0 || flat.size != dim * texts.size) return null
      return List(texts.size) { i -> flat.copyOfRange(i * dim, (i + 1) * dim) }
    }
  }

  fun release() {
    synchronized(lock) {
      if (handle != 0L) NativeBridge.nativeEmbedFree(handle)
      handle = 0L
    }
  }

  private fun ensureLoaded(ctx: Context): Long? {
    if (handle != 0L) return handle
    if (!available(ctx)) return null
    val f = modelFile(ctx) ?: return null
    NativeBridge.ensureLoaded(ctx)
    val threads = maxOf(1, Runtime.getRuntime().availableProcessors() / 2)
    val t0 = System.currentTimeMillis()
    val h = NativeBridge.nativeEmbedLoad(f.absolutePath, threads)
    if (h == 0L) { Log.w(TAG, "embedding model failed to load"); return null }
    Log.i(TAG, "embedding model loaded in ${System.currentTimeMillis() - t0}ms")
    handle = h
    return h
  }
}
```

Wire `release()` into `MainApplication.onTrimMemory(level >= TRIM_MEMORY_RUNNING_LOW)` (find the Application class under `android/app/src/main/java/com/innocorelabs/verbale/`; add the override if absent).

- [ ] **Step 4: Build the Android native lib** — `cd android && ./gradlew :app:compileDebugKotlin` (Kotlin) and `./gradlew :app:externalNativeBuildDebug` (or the full `assembleDebug`) → BUILD SUCCESSFUL. A device test for the JNI path is Task 12 (`embedding_is_a_unit_vector` in `NativePipelineTest`, run tomorrow).

- [ ] **Step 5: Commit** — `git commit -m "feat(search): embeddings through JNI, one resident handle"`

---

### Task 4: Schema — `search_vec`, `asks`, `meetings.embedded_at`

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` (`SCHEMA`, `ADDED_COLUMNS`), `src/db/schema.ts`
- Tests: `android/app/src/test/java/com/innocorelabs/verbale/SchemaTest.kt`, `src/db/__tests__/schema.test.ts`

- [ ] **Step 1: Failing tests** — in `schema.test.ts`, add `'embedded_at'` to the `meetings` column list and:

```ts
  describe('search_vec and asks', () => {
    it('search_vec has the columns the retriever scans, and no foreign key (like search_fts)', () => {
      const cols = columnsOf(freshDb(), 'search_vec').map(c => c.name).sort();
      expect(cols).toEqual(
        ['meeting_id', 'kind', 'ref_id', 'start_ms', 'end_ms', 'speaker_id', 'text', 'hash', 'vec', 'model'].sort(),
      );
    });
    it('asks cascade with their meeting', () => {
      const cols = columnsOf(freshDb(), 'asks').map(c => c.name).sort();
      expect(cols).toEqual(['id', 'meeting_id', 'question', 'answer', 'cites_json', 'asked_at'].sort());
      const fk = freshDb().prepare('PRAGMA foreign_key_list(asks)').all() as { on_delete: string }[];
      expect(fk[0].on_delete).toBe('CASCADE');
    });
    it('embedded_at is a nullable INTEGER with no default', () => {
      const col = column(columnsOf(freshDb(), 'meetings'), 'embedded_at');
      expect(col.type).toBe('INTEGER');
      expect(col.notnull).toBe(0);
      expect(col.dflt_value).toBe(null);
    });
  });
```

In `SchemaTest.kt`: rename `meetingsHasTheSameEighteenColumnsAsTheJavaScriptMirror` → `…Nineteen…`, add `"embedded_at"` to its list, and:

```kotlin
  @Test fun theEmbeddingMarkerIsAnAddedColumn() =
    assertTrue(AudioDb.addedColumnsForTest().contains(Triple("meetings", "embedded_at", "INTEGER")))

  @Test fun searchVecAndAsksExist() {
    assertTrue(schema.any { it.contains("CREATE TABLE IF NOT EXISTS search_vec") })
    assertTrue(schema.any { it.contains("CREATE TABLE IF NOT EXISTS asks") && it.contains("ON DELETE CASCADE") })
    assertTrue(schema.any { it.contains("CREATE INDEX IF NOT EXISTS search_vec_meeting") })
  }
```

- [ ] **Step 2: Run both** → fail.

- [ ] **Step 3: Implement** — Kotlin `SCHEMA` (after the `search_fts` statement):

```kotlin
    // Meaning search. One row per chunk (SearchChunker) of a meeting's transcript, items and
    // summary; `vec` is VecCodec's int8 + scale of a unit vector; `hash` is FNV-1a of `text`, so
    // a re-index re-embeds only chunks whose words changed. No foreign key, like search_fts —
    // deleteMeeting and reindexMeeting delete these rows by hand.
    "CREATE TABLE IF NOT EXISTS search_vec(" +
      "meeting_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT, start_ms INTEGER NOT NULL, " +
      "end_ms INTEGER NOT NULL, speaker_id TEXT, text TEXT NOT NULL, hash INTEGER NOT NULL, " +
      "vec BLOB NOT NULL, model TEXT NOT NULL);",
    "CREATE INDEX IF NOT EXISTS search_vec_meeting ON search_vec(meeting_id);",
    // What a person asked a meeting, and what it answered — a derived document like the summary,
    // inside the privacy boundary, gone with the meeting.
    "CREATE TABLE IF NOT EXISTS asks(" +
      "id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, " +
      "question TEXT NOT NULL, answer TEXT NOT NULL, cites_json TEXT NOT NULL, asked_at INTEGER NOT NULL);",
```

`ADDED_COLUMNS`: `Triple("meetings", "embedded_at", "INTEGER")` with a comment: "NULL = this meeting's current chunk set is not fully embedded; every writer of transcript, items or summary resets it; Embedder.fill stamps it."

TS `schema.ts`: `embedded_at INTEGER` in `meetings`, and the two tables + index in the same words (SQL identical modulo whitespace).

- [ ] **Step 4: Run both** → pass. **Commit** — `git commit -m "feat(search): search_vec, asks and the embedded_at marker, in both mirrors"`

---

### Task 5: `SearchChunker` and `VecCodec` (pure Kotlin)

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/SearchChunker.kt`, `VecCodec.kt`
- Tests: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/SearchChunkerTest.kt`, `VecCodecTest.kt`

- [ ] **Step 1: Failing tests**

```kotlin
class SearchChunkerTest {
  private fun u(id: String, start: Long, end: Long, spk: String?, text: String) =
    AudioDb.Utterance(id, start, end, spk, text)

  @Test fun shortTurnsMergeUpToAHundredWords() {
    val utts = (0 until 30).map { i -> u("u$i", i * 2000L, i * 2000L + 1500, "s1", "one two three four five six seven eight nine ten") }
    val chunks = SearchChunker.chunks(utts)
    assertEquals(3, chunks.size)                       // 30 × 10 words = 300 → 3 windows
    assertEquals("u0", chunks[0].refId)
    assertEquals(0L, chunks[0].startMs)
    assertEquals(9 * 2000L + 1500, chunks[0].endMs)    // ten turns per window
    assertEquals("u10", chunks[1].refId)
    assertFalse(chunks[0].text.contains("s1"))         // words only, never the speaker
  }

  @Test fun aGapOfMoreThanThirtySecondsStartsANewWindow() {
    val utts = listOf(u("a", 0, 1000, "s1", "hello there"), u("b", 40_000, 41_000, "s2", "back again"))
    val chunks = SearchChunker.chunks(utts)
    assertEquals(2, chunks.size)
    assertEquals("b", chunks[1].refId)
    assertEquals("s2", chunks[1].speakerId)
  }

  @Test fun oneLongLineIsItsOwnWindow() {
    val long = (1..150).joinToString(" ") { "w$it" }
    val utts = listOf(u("a", 0, 1000, "s1", "short"), u("b", 1000, 9000, "s1", long), u("c", 9000, 9500, "s1", "tail"))
    val chunks = SearchChunker.chunks(utts)
    assertEquals(3, chunks.size)
    assertEquals(long, chunks[1].text)
  }

  @Test fun hashIsStableAndSensitiveToTheWords() {
    assertEquals(SearchChunker.hash("a b"), SearchChunker.hash("a b"))
    assertNotEquals(SearchChunker.hash("a b"), SearchChunker.hash("a c"))
  }
}

class VecCodecTest {
  @Test fun roundTripsAUnitVectorToWithinTwoHundredths() {
    val rnd = java.util.Random(7)
    val v = FloatArray(384) { rnd.nextGaussian().toFloat() }
    val n = Math.sqrt(v.sumOf { (it * it).toDouble() }).toFloat()
    for (i in v.indices) v[i] /= n
    val blob = VecCodec.encode(v)
    assertEquals(384 + 4, blob.size)
    val q = VecCodec.encode(v)
    val cos = VecCodec.dot(v, blob)
    assertTrue("cosine with itself was $cos", cos > 0.98f && cos <= 1.001f)
    assertEquals(cos, VecCodec.dot(v, q), 1e-6f)
  }

  @Test fun orthogonalVectorsScoreNearZero() {
    val a = FloatArray(384).also { it[0] = 1f }
    val b = FloatArray(384).also { it[1] = 1f }
    assertEquals(0f, VecCodec.dot(a, VecCodec.encode(b)), 1e-3f)
  }
}
```

(Check `AudioDb.Utterance`'s real constructor — `grep -n "data class Utterance" AudioDb.kt` — and adjust the fixture helper to its parameter order.)

- [ ] **Step 2: Run** → fail (unresolved references).

- [ ] **Step 3: Implement**

```kotlin
package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb

/**
 * The unit of meaning search: consecutive turns merged into windows of up to a hundred words,
 * never across a silence longer than thirty seconds, a single long turn standing alone. The
 * embedded text is the words only — no names, no stamps — so a speaker rename never invalidates
 * a vector, and `hash` (FNV-1a of the words) is what says whether one must be recomputed.
 */
object SearchChunker {
  const val MAX_WORDS = 100
  const val MAX_GAP_MS = 30_000L

  data class Chunk(val refId: String, val startMs: Long, val endMs: Long, val speakerId: String?, val text: String)

  fun chunks(utts: List<AudioDb.Utterance>): List<Chunk> {
    val out = ArrayList<Chunk>()
    var refId: String? = null; var start = 0L; var end = 0L; var spk: String? = null
    var words = 0
    val sb = StringBuilder()
    fun flush() {
      if (refId != null && sb.isNotEmpty()) out.add(Chunk(refId!!, start, end, spk, sb.toString().trim()))
      refId = null; sb.setLength(0); words = 0
    }
    for (u in utts) {
      val text = u.text.trim()
      if (text.isEmpty()) continue
      val n = text.split(Regex("\\s+")).size
      val gap = refId != null && u.startMs - end > MAX_GAP_MS
      if (refId != null && (gap || words + n > MAX_WORDS)) flush()
      if (refId == null) { refId = u.id; start = u.startMs; spk = u.speakerId }
      if (sb.isNotEmpty()) sb.append(' ')
      sb.append(text)
      words += n
      end = u.endMs
      if (words >= MAX_WORDS) flush()
    }
    flush()
    return out
  }

  /** FNV-1a over UTF-8, as a signed 64-bit for SQLite. */
  fun hash(text: String): Long {
    var h = -0x340d631b7bdddcdbL  // 0xcbf29ce484222325
    for (b in text.toByteArray(Charsets.UTF_8)) { h = h xor (b.toLong() and 0xff); h *= 0x100000001b3L }
    return h
  }
}
```

```kotlin
package com.innocorelabs.verbale.pipeline

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A unit vector as 384 signed bytes and one float scale: `x ≈ q * scale`. Four times smaller
 * than floats and the whole library's vectors scan in Kotlin in tens of milliseconds; the
 * ranking loses nothing a person could see (round trip cosine > 0.98). Little-endian, scale
 * first, so the blob is self-describing to anything that reads the table.
 */
object VecCodec {
  fun encode(v: FloatArray): ByteArray {
    var max = 0f
    for (x in v) if (Math.abs(x) > max) max = Math.abs(x)
    val scale = if (max > 0f) max / 127f else 1f
    val buf = ByteBuffer.allocate(4 + v.size).order(ByteOrder.LITTLE_ENDIAN)
    buf.putFloat(scale)
    for (x in v) buf.put(Math.round(x / scale).coerceIn(-127, 127).toByte())
    return buf.array()
  }

  /** `q · blob` — a cosine when both are unit vectors. */
  fun dot(q: FloatArray, blob: ByteArray): Float {
    val buf = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN)
    val scale = buf.getFloat()
    var s = 0f
    val n = minOf(q.size, blob.size - 4)
    for (i in 0 until n) s += q[i] * buf.get(4 + i)
    return s * scale
  }
}
```

- [ ] **Step 4: Run** → pass. **Mutation-check**: `MAX_GAP_MS` → `3_000_000` (gap test fails); drop the `words >= MAX_WORDS` flush (merge test's count fails); `hash` returning `text.length.toLong()` (sensitivity test fails); `encode` forgetting the scale (round-trip fails); `dot` reading from offset 0 (orthogonal/round-trip fail). Restore each.

- [ ] **Step 5: Commit** — `git commit -m "feat(search): chunks of a hundred words, and vectors as bytes"`

---

### Task 6: `Embedder.fill`, the EMBED stage, and the backfill

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Embedder.kt`
- Modify: `AudioDb.kt` (vec helpers; `embedded_at` resets in `replaceUtterancesJson`, `replaceMinutes`, `replaceItems`, `classifyItem`, `reindexMeeting`; deletes in `deleteMeeting` and `reindexMeeting`), `ProcessingEngine.kt` (after narrate), `StorageModule.kt` + `src/native/NativeStorage.ts` + `src/db/queries.ts` (`backfillEmbeddings`), `src/pipeline/PipelineController.ts` (sweep)
- Tests: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/EmbedderTest.kt` (the pure plan), `android/app/src/androidTest/.../AudioDbTest.kt` (phone, Task 12)

- [ ] **Step 1: The pure part first — a failing test for the plan** (`EmbedderTest.kt`):

```kotlin
class EmbedderTest {
  @Test fun onlyChunksWhoseHashIsNewAreEmbedded_andStaleRowsAreDropped() {
    val wanted = listOf(
      Embedder.Want("turn", "u1", 0, 1000, "s1", "the proposal is due friday"),
      Embedder.Want("turn", "u2", 1000, 2000, "s2", "only a draft"),
      Embedder.Want("item", "i1", 0, 1000, null, "send the proposal"),
    )
    val have = setOf(SearchChunker.hash("only a draft"), SearchChunker.hash("gone words"))
    val plan = Embedder.plan(wanted, have)
    assertEquals(listOf("u1", "i1"), plan.toEmbed.map { it.refId })
    assertEquals(setOf(SearchChunker.hash("gone words")), plan.toDelete)
  }
}
```

- [ ] **Step 2: Implement `Embedder`**

```kotlin
package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb

/**
 * Keeps one meeting's vectors equal to its current words. Chunks the transcript, adds the items
 * and the summary, embeds only what is new by hash, deletes what is gone, then stamps
 * `embedded_at`. Idempotent and resumable: killed halfway, the next call finishes the rest.
 * Without a subscription or the model it returns false and writes nothing — the sweep that
 * called it stops asking.
 */
object Embedder {
  private const val TAG = "Embed"
  const val BATCH = 16

  data class Want(val kind: String, val refId: String, val startMs: Long, val endMs: Long, val speakerId: String?, val text: String) {
    val hash: Long get() = SearchChunker.hash(text)
  }
  data class Plan(val toEmbed: List<Want>, val toDelete: Set<Long>)

  /** Pure: what to embed and what to drop, given what the meeting wants and what the table has. */
  fun plan(wanted: List<Want>, have: Set<Long>): Plan {
    val wantHashes = wanted.map { it.hash }.toSet()
    return Plan(wanted.filter { it.hash !in have }, have.filter { it !in wantHashes }.toSet())
  }

  fun wanted(db: AudioDb, meetingId: String): List<Want> {
    val out = ArrayList<Want>()
    for (c in SearchChunker.chunks(db.utterances(meetingId))) out.add(Want("turn", c.refId, c.startMs, c.endMs, c.speakerId, c.text))
    for (i in db.itemsForIndex(meetingId)) out.add(Want("item", i.id, i.startMs, i.startMs, null, i.text))
    db.summaryText(meetingId)?.let { if (it.isNotBlank()) out.add(Want("summary", meetingId, 0, 0, null, it)) }
    return out
  }

  /**
   * @param pause called between batches — the processing service's thermal clearance; the
   *   backfill passes {}.
   * @return true when the meeting is now fully embedded.
   */
  fun fill(ctx: Context, meetingId: String, onProgress: (Int, Int) -> Unit = { _, _ -> }, pause: () -> Unit = {}): Boolean {
    if (!EmbedRuntime.available(ctx)) return false
    val db = AudioDb.get(ctx)
    val p = plan(wanted(db, meetingId), db.vecHashes(meetingId))
    db.deleteVecs(meetingId, p.toDelete)
    val total = p.toEmbed.size
    var done = 0
    for (batch in p.toEmbed.chunked(BATCH)) {
      pause()
      val vecs = EmbedRuntime.embed(ctx, batch.map { it.text }) ?: return false
      val rows = batch.zip(vecs).filter { (_, v) -> v.any { it != 0f } }
      db.insertVecs(meetingId, rows.map { (w, v) -> AudioDb.VecRow(w.kind, w.refId, w.startMs, w.endMs, w.speakerId, w.text, w.hash, VecCodec.encode(v), EmbedRuntime.MODEL_ID) })
      done += batch.size
      onProgress(done, total)
    }
    db.stampEmbedded(meetingId)
    Log.i(TAG, "embedded $total chunk(s) for $meetingId (${p.toDelete.size} dropped)")
    return true
  }
}
```

- [ ] **Step 3: AudioDb helpers** (near the search index helpers):

```kotlin
  data class VecRow(val kind: String, val refId: String, val startMs: Long, val endMs: Long, val speakerId: String?,
                    val text: String, val hash: Long, val vec: ByteArray, val model: String)
  data class IndexItem(val id: String, val startMs: Long, val text: String)

  fun vecHashes(meetingId: String): Set<Long> {
    val out = HashSet<Long>()
    db.rawQuery("SELECT hash FROM search_vec WHERE meeting_id=?", arrayOf(meetingId)).use { c -> while (c.moveToNext()) out.add(c.getLong(0)) }
    return out
  }
  fun deleteVecs(meetingId: String, hashes: Set<Long>) {
    for (h in hashes) db.execSQL("DELETE FROM search_vec WHERE meeting_id=? AND hash=?", arrayOf<Any?>(meetingId, h))
  }
  fun insertVecs(meetingId: String, rows: List<VecRow>) {
    db.beginTransaction()
    try {
      for (r in rows) db.execSQL(
        "INSERT INTO search_vec(meeting_id,kind,ref_id,start_ms,end_ms,speaker_id,text,hash,vec,model) VALUES(?,?,?,?,?,?,?,?,?,?)",
        arrayOf<Any?>(meetingId, r.kind, r.refId, r.startMs, r.endMs, r.speakerId, r.text, r.hash, r.vec, r.model),
      )
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
  }
  fun stampEmbedded(meetingId: String) =
    db.execSQL("UPDATE meetings SET embedded_at=? WHERE id=?", arrayOf<Any?>(System.currentTimeMillis(), meetingId))
  /** Every writer of words calls this: the vectors no longer describe the meeting. */
  private fun unstampEmbedded(meetingId: String) =
    db.execSQL("UPDATE meetings SET embedded_at=NULL WHERE id=?", arrayOf<Any?>(meetingId))
  /** Items as the embedder wants them: text and moment, rejected rows excluded (same rule as indexItems). */
  fun itemsForIndex(meetingId: String): List<IndexItem> { /* SELECT id, CASE WHEN gen_version=? THEN 0 ELSE anchor_start_ms END, text FROM items WHERE meeting_id=? AND review<>'rejected' ORDER BY anchor_start_ms */ }
  /** The narrated summary's plain text, or the rule one, or null. */
  fun summaryText(meetingId: String): String? { /* prefer source='llm' kind='summary', else source='rule'; plainText(content_json) */ }
  fun unembeddedMeetings(limit: Int): List<String> { /* SELECT id FROM meetings m WHERE embedded_at IS NULL AND EXISTS(SELECT 1 FROM utterances u WHERE u.meeting_id=m.id) ORDER BY created_at DESC LIMIT ? */ }
  fun unembeddedCount(): Int { /* the same predicate, count(*) — written once as a private val UNEMBEDDED like UNMIGRATED */ }
```

Call `unstampEmbedded(meetingId)` inside the transactions of `replaceUtterancesJson`, `replaceMinutes`, `replaceItems`, and at the end of `classifyItem`; in `reindexMeeting` too. In `deleteMeeting` add `db.execSQL("DELETE FROM search_vec WHERE meeting_id=?", …)` beside the `search_fts` delete. (Do NOT delete vec rows in `reindexMeeting` — the hash diff keeps what is still true.)

- [ ] **Step 4: The stage** — in `ProcessingEngine`, after the narrate block and before `applyRetention`:

```kotlin
        // ---- Meaning index (Pro): vectors for search and Ask. Idempotent by hash; a free user
        // or a phone without the model skips it silently, and the JS sweep's backfill is the retry.
        if (EmbedRuntime.available(ctx)) {
          awaitClearance()
          val t0 = System.currentTimeMillis(); val p0 = pausedMs
          val ok = try {
            Embedder.fill(ctx, meetingId, onProgress = { d, t -> listener.onStage("embed", d, t) }, pause = { awaitClearance() })
          } catch (e: Throwable) { Log.w(TAG, "embedding failed for $meetingId", e); false }
          if (ok) stageDone("embed", t0, p0)
          if (checkCancelled()) return
        }
```

`StageRates`/`progress.ts` know stages by name: add `"embed"` wherever `"narrate"` is listed with a label ("Indexing meaning…") — `grep -rn "narrate" android/app/src/main/java/com/innocorelabs/verbale/pipeline/StageRates.kt src/pipeline/progress.ts src/screens/meeting/*.tsx` and mirror each site; the jest `progress.test.ts` gets a row for it.

- [ ] **Step 5: The backfill** — `StorageModule`:

```kotlin
  /** Embed up to `limit` meetings whose vectors are stale, newest first; resolves with the true backlog. Nothing without Pro + the model. */
  @ReactMethod
  fun backfillEmbeddings(limit: Double, promise: Promise) {
    Thread {
      try {
        val db = AudioDb.get(ctx)
        if (EmbedRuntime.available(ctx)) for (id in db.unembeddedMeetings(limit.toInt())) Embedder.fill(ctx, id)
        promise.resolve(db.unembeddedCount().toDouble())
      } catch (e: Throwable) { promise.reject("db_embed", e) }
    }.start()
  }
```

`NativeStorage.ts`: `backfillEmbeddings(limit: number): Promise<number>;` with a two-line comment. `queries.ts`: `backfillEmbeddings: (limit = 3) => Storage.backfillEmbeddings(limit),` — three, not twenty-five: each meeting is seconds of CPU. `PipelineController.sweep`: after `backfillSearch()`, `await this.backfillEmbeddings()` with the same try/catch shape, logging `meaning index: N meeting(s) to go`.

- [ ] **Step 6: Run** `EmbedderTest`, `progress.test.ts`, `npx tsc --noEmit`, `./gradlew :app:compileDebugKotlin`. Mutation-check `plan`: keep every wanted chunk (test's `toEmbed` fails); never delete (`toDelete` fails).

- [ ] **Step 7: Commit** — `git commit -m "feat(search): every processed meeting gets its vectors; the sweep catches the library up"`

---

### Task 7: `Retriever`, hybrid `searchJson`, the "≈" mark

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Retriever.kt`, test `RetrieverTest.kt`
- Modify: `AudioDb.kt` (`searchJson(term, meetingId: String? = null)`, `meaningHits`), `src/pipeline/types.ts` (`SearchHit.byMeaning?: boolean`), `src/screens/SearchScreen.tsx` (the mark), `src/screens/__tests__/searchKinds.test.ts` or a new `SearchScreen.test.tsx`

- [ ] **Step 1: Failing tests**

```kotlin
class RetrieverTest {
  private fun h(id: String, score: Double, meaning: Boolean = false) =
    Retriever.Hit("m1", "utterance", id, 0, 0, "text $id", score, meaning)

  @Test fun reciprocalRankFusionOrdersByBothLists() {
    val kw = listOf(h("a", 9.0), h("b", 8.0), h("c", 7.0))
    val mn = listOf(h("c", .9, true), h("d", .8, true), h("a", .7, true))
    val fused = Retriever.fuse(kw, mn)
    assertEquals(listOf("a", "c", "b", "d"), fused.map { it.refId })  // a: 1/61+1/63; c: 1/63+1/61; tie → keyword order; b: 1/62; d: 1/62 — b before d by list order
    assertFalse(fused[0].byMeaning)   // found by words too
    assertTrue(fused[3].byMeaning)    // only meaning had it
  }

  @Test fun aHitInBothListsIsOneRow() {
    val fused = Retriever.fuse(listOf(h("a", 1.0)), listOf(h("a", .5, true)))
    assertEquals(1, fused.size)
  }

  @Test fun topKCutsTheTail() {
    val fused = Retriever.fuse((1..100).map { h("k$it", 100.0 - it) }, emptyList(), top = 60)
    assertEquals(60, fused.size)
  }
}
```

- [ ] **Step 2: Implement**

```kotlin
object Retriever {
  data class Hit(val meetingId: String, val kind: String, val refId: String?, val startMs: Long, val endMs: Long,
                 val snippet: String, val score: Double, val byMeaning: Boolean)

  /**
   * Reciprocal rank fusion (k = 60): each list votes 1/(k+rank) for a row; a row in both lists
   * sums its votes. Scale-free, which is the point — bm25 and cosine have nothing in common but
   * their order. Ties keep the keyword list's order. `byMeaning` survives only for a row the
   * keyword list did not have.
   */
  fun fuse(keyword: List<Hit>, meaning: List<Hit>, k: Int = 60, top: Int = 60): List<Hit> {
    val score = LinkedHashMap<String, Double>()
    val row = HashMap<String, Hit>()
    fun key(h: Hit) = "${h.meetingId}/${h.kind}/${h.refId}"
    keyword.forEachIndexed { i, h -> val id = key(h); score[id] = (score[id] ?: 0.0) + 1.0 / (k + i + 1); row[id] = h.copy(byMeaning = false) }
    meaning.forEachIndexed { i, h -> val id = key(h); score[id] = (score[id] ?: 0.0) + 1.0 / (k + i + 1); if (id !in row) row[id] = h.copy(byMeaning = true) }
    return score.entries.sortedByDescending { it.value }.take(top).map { row[it.key]!!.copy(score = it.value) }
  }
}
```

(`sortedByDescending` is stable, and `score` is insertion-ordered keyword-first, so ties keep the keyword order.)

- [ ] **Step 3: `AudioDb.searchJson`** — keep the FTS query; convert its rows to `Retriever.Hit`; then:

```kotlin
    val meaning = meaningHits(term, meetingId, 40)
    val fused = Retriever.fuse(keyword, meaning)
    return JSONArray(fused.map { h -> JSONObject().put("meetingId", h.meetingId).put("kind", h.kind).put("refId", h.refId ?: JSONObject.NULL)
      .put("startMs", h.startMs).put("snippet", h.snippet).put("score", h.score).put("byMeaning", h.byMeaning) }).toString()
```

`meaningHits(term, meetingId, top)`: `EmbedRuntime.embed(ctx, listOf(term))?.firstOrNull() ?: return emptyList()` (the AudioDb needs a `Context` for that — pass it in: `searchJson(ctx, term, meetingId)`, and `StorageModule.search` passes `ctx`); scan `SELECT meeting_id,kind,ref_id,start_ms,end_ms,text,vec FROM search_vec [WHERE meeting_id=?]`, score with `VecCodec.dot`, keep a bounded top-`top` list (a `PriorityQueue`), snippet = first 120 chars of `text`. `kind` maps `turn → utterance` so the screen's kind labels apply. Keyword hits keep `endMs = startMs`.

- [ ] **Step 4: Screen** — `SearchHit` gains `byMeaning?: boolean`. In `SearchScreen`'s `Hit` row, before the snippet runs: `{hit.byMeaning ? <Txt variant="chipSm" color={colors.inkSoft} accessibilityLabel="found by meaning">≈ </Txt> : null}`. Under the results (or the empty state), when `db.backfillEmbeddings(0)` — a count, no work — is > 0: `Txt chipSoft` "Meaning search is still indexing N meeting(s)". Test (`SearchScreen.test.tsx`, mocking `db.search` to return one `byMeaning` hit and one not, and `db.backfillEmbeddings` → 3): the marked row's text starts with "≈", the other's does not; the note names 3.

- [ ] **Step 5: Run** all three; mutation-check `fuse` (k=0 breaks the tie order; forgetting `byMeaning=false` on the keyword row fails the first test). Commit — `git commit -m "feat(search): keyword and meaning hits, one list"`

---

### Task 8: The two search defects

**Files:** `AudioDb.kt` (`indexMinutes`, `unindexedCount`), `StorageModule.kt` (`backfillSearch`), tests in the phone `AudioDbTest` (Task 12) and a pure `SearchIndexRulesTest.kt` for the kind filter

- [ ] **Step 1:** `indexMinutes(meetingId)`: `val skip = if (hasRuleItems(meetingId)) ITEM_KINDS else emptyList()`; the SELECT adds `AND kind NOT IN (…)` when `skip` is non-empty (build the placeholders). Pull the decision into a pure `fun minuteKindsToIndex(hasRuleItems: Boolean): String` ("`kind <> 'summary'`" vs "`kind NOT IN ('summary','decision','action','question')`") and test it.
- [ ] **Step 2:** `unindexedCount()` beside `unindexedMeetings` with the predicate written once (`private val UNINDEXED = "FROM meetings m WHERE EXISTS(...) AND NOT EXISTS(SELECT 1 FROM search_fts f WHERE f.meeting_id=m.id)"`); `StorageModule.backfillSearch` resolves `db.unindexedCount()`.
- [ ] **Step 3:** Commit — `git commit -m "fix(search): a decision is one card, and the backlog is a count"`

---

### Task 9: `askPrompt` and `validateAnswer` (C++), the fence, JNI

**Files:**
- Create: `cpp/minutes/ask.h`, `cpp/minutes/ask.cpp`, `cpp/tests/test_ask.cpp`
- Modify: `cpp/CMakeLists.txt`, `cpp/cli/CMakeLists.txt`, `cpp/jni/audionotes_jni.cpp`, `NativeBridge.kt`, `scripts/check-prompt-fencing.py` (only if its list of prompt builders is explicit — read it first)

- [ ] **Step 1: Failing test** — `cpp/tests/test_ask.cpp` (the `CHECK` macro as in `test_evidence_record`):

```cpp
static std::vector<AskPassage> passages() {
  return {{"Priya", 5000, "Can you send the proposal Friday?"},
          {"Rahul", 6500, "Only a draft; the final version needs another week."},
          {"Priya", 9000, "Fine, a draft then."}};
}

static void promptIsNumberedAndFenced() {
  const std::string p = askPrompt("did we agree on a date for the proposal?", passages());
  CHECK(p.find("[1] Priya (0:05): Can you send the proposal Friday?") != std::string::npos);
  CHECK(p.find("[2] Rahul (0:06): Only a draft") != std::string::npos);
  CHECK(p.find("RECORD OF A MEETING") != std::string::npos);   // the passages went through the fence
  CHECK(p.find("did we agree on a date") != std::string::npos);
  CHECK(p.find(kAskNothing) != std::string::npos);            // the model is told the refusal phrase
}

static void validatorKeepsInRangeCitesInOrder() {
  const AskAnswer a = validateAnswer("A draft goes Friday [2][1]; the final needs a week [2].", 3);
  CHECK(!a.nothing);
  CHECK(a.cites.size() == 2 && a.cites[0] == 2 && a.cites[1] == 1);
  CHECK(a.text == "A draft goes Friday [2][1]; the final needs a week [2].");
}

static void validatorStripsOutOfRangeCites() {
  const AskAnswer a = validateAnswer("Friday [9], said Rahul [1].", 3);
  CHECK(a.text == "Friday, said Rahul [1].");
  CHECK(a.cites.size() == 1 && a.cites[0] == 1);
}

static void noCitationIsNothing() {
  CHECK(validateAnswer("They agreed on Friday.", 3).nothing);
  CHECK(validateAnswer("Friday [7].", 3).nothing);
  CHECK(validateAnswer("", 3).nothing);
}

static void theRefusalPhraseIsNothing() {
  CHECK(validateAnswer(std::string(kAskNothing) + " [1]", 3).nothing);
}
```

- [ ] **Step 2: Implement** — `ask.h`:

```cpp
#pragma once
#include <string>
#include <vector>

namespace audionotes {

struct AskPassage { std::string speaker; long start_ms; std::string text; };
struct AskAnswer { std::string text; std::vector<int> cites; bool nothing; };

// What the model is told to say when the passages do not answer, and what the validator treats
// as "no answer" when it says it.
extern const char* const kAskNothing;

// The passages numbered [1]..[n] with speaker and m:ss stamp, then the question — both through the
// fence, so nothing quoted can read as an instruction. At most three sentences, cite each claim.
std::string askPrompt(const std::string& question, const std::vector<AskPassage>& passages);

// Citations outside 1..n are removed from the text (with a preceding space, if any); an answer
// left without one, or that contains kAskNothing, is `nothing`. Cites: unique, first-mention order.
AskAnswer validateAnswer(const std::string& text, int n_passages);

}  // namespace audionotes
```

`ask.cpp`: `kAskNothing = "Nothing in this meeting settles that."`; `askPrompt` builds `"[n] Speaker (m:ss): text\n"` lines, calls `fenceTranscript(lines)` (the same helper `classifyPrompt` uses — read `cpp/minutes/fence.h` for its exact name/signature) for the passages and for the question, and writes: `"Answer the question from the numbered passages only, in at most three sentences. After each claim write the passage number in square brackets, like [2]. If the passages do not answer it, write exactly: " + kAskNothing`. `validateAnswer`: scan for `[digits]`, keep in range, erase others (and one space before), collect unique cites; `nothing = cites.empty() || text.find(kAskNothing) != npos`.

- [ ] **Step 3: Register** the source and the test (copy `test_evidence_record`'s lines); build; run `test_ask` → ok; run `python3 scripts/check-prompt-fencing.py` → passes and names `askPrompt` as fenced (if the script lists prompt builders explicitly, add `askPrompt`).

- [ ] **Step 4: JNI** — `nativeAskPrompt(question, speakers[], startMs[], texts[]) → String`, `nativeAskNothing() → String` (the constant, so Kotlin never spells it) and `nativeValidateAnswer(text, n) → String` (JSON `{"text":…,"cites":[…],"nothing":bool}` — hand-built like `toJson` in evidence_record; escape quotes/backslashes/newlines). Externs in `NativeBridge.kt`.

- [ ] **Step 5: Mutation-check** (`validateAnswer` keeps `[9]`; `askPrompt` skips the fence — the `RECORD OF A MEETING` check fails). Commit — `git commit -m "feat(ask): the prompt is fenced and numbered; an answer must cite or say nothing"`

---

### Task 10: `Asker` and `LlmModule.ask`

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Asker.kt`, test `AskerTest.kt`
- Modify: `AudioDb.kt` (`asks` helpers: `insertAsk`, `asksJson(meetingId)`), `LlmModule.kt` (`ask`, `asks`), `src/native/NativeLlm.ts`, `ProcessingService.kt` (`isBusy()` static)

- [ ] **Step 1: Failing test** — the gate and the pure bits:

```kotlin
class AskerTest {
  @Test fun theGateFailsInOrder() {
    assertEquals(Asker.Refusal.NOT_PRO, Asker.gate(entitled = false, writer = true, embed = true, capable = true, busy = false))
    assertEquals(Asker.Refusal.NO_MODEL, Asker.gate(true, writer = false, embed = true, capable = true, busy = false))
    assertEquals(Asker.Refusal.NO_MODEL, Asker.gate(true, true, embed = false, capable = true, busy = false))
    assertEquals(Asker.Refusal.NOT_CAPABLE, Asker.gate(true, true, true, capable = false, busy = false))
    assertEquals(Asker.Refusal.BUSY, Asker.gate(true, true, true, true, busy = true))
    assertNull(Asker.gate(true, true, true, true, false))
  }

  @Test fun passagesAreTheTopEightFusedHitsWithTheirSpeakersNamed() {
    val hits = (1..12).map { Retriever.Hit("m1", "utterance", "u$it", it * 1000L, it * 1000L + 500, "words $it", 1.0 / it, it % 2 == 0) }
    val names = mapOf("s1" to "Priya")
    val p = Asker.passages(hits, speakerOf = { if (it == "u2") "s1" else null }, names)
    assertEquals(8, p.size)
    assertEquals("Priya", p[1].speaker)
    assertEquals("Someone", p[0].speaker)
    assertEquals(1000L, p[0].startMs)
  }

  @Test fun theStoredRowCarriesTheCitesAsMoments() {
    val cites = Asker.citesJson(listOf(2, 1), listOf(AskPassageK("Priya", 5000, "a", "u1"), AskPassageK("Rahul", 6500, "b", "u2")))
    val arr = JSONArray(cites)
    assertEquals(2, arr.length())
    assertEquals(6500L, arr.getJSONObject(0).getLong("startMs"))
    assertEquals("Rahul", arr.getJSONObject(0).getString("speaker"))
    assertEquals(2, arr.getJSONObject(0).getInt("n"))
  }
}
```

- [ ] **Step 2: Implement** `Asker.kt`: `enum class Refusal { NOT_PRO, NO_MODEL, NOT_CAPABLE, BUSY }`, `gate(...)`, `data class AskPassageK(speaker, startMs, text, refId)`, `passages(hits, speakerOf, names)` (top 8; speaker from the utterance's speaker id → display name, else "Someone"; for `item`/`summary` kinds the speaker is "Minutes"), `citesJson(cites, passages)` → `[{n, refId, startMs, speaker}]`, and:

```kotlin
  data class Result(val refusal: Refusal?, val answer: String, val citesJson: String, val nothing: Boolean, val askId: String?)

  fun ask(ctx: Context, meetingId: String, question: String, handle: () -> Long): Result {
    val db = AudioDb.get(ctx)
    gate(LicenceStore.entitled(ctx), Narrator.modelFile(ctx) != null, EmbedRuntime.modelFile(ctx) != null,
         Narrator.capable(ctx), ProcessingService.isBusy())?.let { return Result(it, "", "[]", true, null) }
    val hits = db.searchHits(ctx, question.trim(), meetingId).take(8)   // the fused list, this meeting only
    val names = db.speakers(meetingId).associate { it.id to (it.displayName ?: "Someone") }
    val ps = passages(hits, speakerOf = { db.utteranceSpeaker(it) }, names)
    if (ps.isEmpty()) return store(db, meetingId, question, kAskNothing(), "[]", nothing = true)
    val prompt = NativeBridge.nativeAskPrompt(question, ps.map { it.speaker }.toTypedArray(), ps.map { it.startMs }.toLongArray(), ps.map { it.text }.toTypedArray())
    val h = handle()
    if (h == 0L) return Result(Refusal.NO_MODEL, "", "[]", true, null)
    val raw = NativeBridge.nativeLlmGenerate(h, prompt, MAX_TOKENS).trim()
    val v = JSONObject(NativeBridge.nativeValidateAnswer(raw, ps.size))
    val nothing = v.getBoolean("nothing")
    val cites = if (nothing) emptyList() else (0 until v.getJSONArray("cites").length()).map { v.getJSONArray("cites").getInt(it) }
    return store(db, meetingId, question, if (nothing) kAskNothing() else v.getString("text"), citesJson(cites.ifEmpty { listOf(1, 2, 3).take(ps.size) }, ps), nothing)
  }
```

(`kAskNothing()` reads the C++ constant through `nativeAskNothing()`; a `nothing` answer stores the three closest passages as its cites so the screen can show them.) `MAX_TOKENS = 200`.

`ProcessingService.isBusy()`: `instance?.running == true` in the companion. `AudioDb`: `insertAsk`, `asksJson(meetingId)` (ordered by `asked_at`), `utteranceSpeaker(id)`, `searchHits(ctx, term, meetingId)` (the list `searchJson` serialises — refactor `searchJson` to call it).

`LlmModule`: `@ReactMethod fun ask(meetingId: String, question: String, promise: Promise)` on a `Thread` — `Asker.ask(ctx, meetingId, question) { ensureLoadedHandle() }` where `ensureLoadedHandle()` is the existing `load` logic made synchronous and reused; resolves the JSON `{refusal, answer, cites, nothing, id}`. `@ReactMethod fun asks(meetingId, promise)` → `asksJson`. `NativeLlm.ts`: `ask(meetingId: string, question: string): Promise<string>; asks(meetingId: string): Promise<string>;`.

- [ ] **Step 3: Run** `AskerTest`; compile; mutation-check the gate order (swap NOT_PRO/NO_MODEL) and `passages` (take 9). Commit — `git commit -m "feat(ask): retrieve, ask the writer, keep the exchange"`

---

### Task 11: `AskScreen`, the route, the header button, the icon

**Files:**
- Create: `src/screens/AskScreen.tsx`, `src/screens/__tests__/AskScreen.test.tsx`
- Modify: `src/navigation/RootNavigator.tsx` (`Ask: { meetingId: string }`, `Stack.Screen`), `src/screens/MeetingScreen.tsx` (header `IconButton icon="chat" label="Ask this meeting"` before the More button; a `sheetActions` row "Ask this meeting"), `src/components/Icon.tsx` (`'chat'`: a speech bubble — `<Path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.8-.3-4-.9L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5z" />`), `src/db/queries.ts` (`asks`, `ask`)
- Test mocks: `MeetingScreen.test.tsx` and `ItemProvenance.test.tsx` need no new `db.*` stubs unless MeetingScreen reads asks (it does not).

- [ ] **Step 1: Failing test** — `AskScreen.test.tsx` (the `render`/`press`/`texts` helpers as in `ReviewScreen.test.tsx`; mock `../../native/NativeLlm` with `ask`, `asks`, `unload`):

```tsx
  it('shows the meeting’s past asks, newest last, with their citations', async () => {
    (Llm.asks as jest.Mock).mockResolvedValue(JSON.stringify([
      { id: 'a1', question: 'when is the proposal due?', answer: 'A draft goes Friday [1]; the final needs another week [2].',
        cites: [{ n: 1, refId: 'u1', startMs: 5000, speaker: 'Priya' }, { n: 2, refId: 'u2', startMs: 6500, speaker: 'Rahul' }], nothing: false, askedAt: 1 },
    ]));
    const tree = await render();
    const t = texts(tree);
    expect(t).toContain('when is the proposal due?');
    expect(t.some(x => x.includes('A draft goes Friday'))).toBe(true);
    expect(t).toContain('[1] Priya · 0:05');
    expect(t).toContain('[2] Rahul · 0:06');
  });

  it('a citation opens the transcript at that moment', async () => {
    (Llm.asks as jest.Mock).mockResolvedValue(JSON.stringify([/* as above */]));
    const tree = await render();
    await press(tree, 'Play [2] Rahul at 0:06');
    expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm1', tab: 'transcript', atMs: 6500 });
  });

  it('sending a question asks the meeting and appends the answer', async () => {
    (Llm.asks as jest.Mock).mockResolvedValue('[]');
    (Llm.ask as jest.Mock).mockResolvedValue(JSON.stringify({ id: 'a2', refusal: null, answer: 'Friday [1].', cites: [{ n: 1, refId: 'u1', startMs: 5000, speaker: 'Priya' }], nothing: false }));
    const tree = await render();
    const input = tree.root.findByProps({ placeholder: 'Ask this meeting…' });
    await act(async () => { input.props.onChangeText('when?'); });
    await press(tree, 'Ask');
    expect(Llm.ask).toHaveBeenCalledWith('m1', 'when?');
    expect(texts(tree).some(x => x.includes('Friday [1].'))).toBe(true);
  });

  it('a refusal for a free user opens the paywall', async () => {
    (Llm.asks as jest.Mock).mockResolvedValue('[]');
    (Llm.ask as jest.Mock).mockResolvedValue(JSON.stringify({ refusal: 'NOT_PRO', answer: '', cites: [], nothing: true }));
    const tree = await render();
    const input = tree.root.findByProps({ placeholder: 'Ask this meeting…' });
    await act(async () => { input.props.onChangeText('when?'); });
    await press(tree, 'Ask');
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { meetingId: 'm1' });
  });

  it('BUSY and NO_MODEL say so in the thread', async () => { /* the two notes: 'The writer is busy with a meeting — try again in a minute.' and 'Install the writer and the meaning index in Settings to ask.' */ });

  it('leaving the screen releases the writer', async () => {
    (Llm.asks as jest.Mock).mockResolvedValue('[]');
    const tree = await render();
    await act(async () => { tree.unmount(); });
    expect(Llm.unload).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Implement** `AskScreen.tsx`: state `thread: Ask[]`, `draft`, `busy`; load `db.asks(meetingId)` on mount; `send()` → `db.ask(meetingId, draft)` → on `refusal`: `NOT_PRO` → `navigation.navigate('Paywall', { meetingId })`; `NO_MODEL`/`BUSY`/`NOT_CAPABLE` → a note card; else append. Each answer card: the question (`Txt bodyStrong`), the answer (`Txt prose`), citation chips `Pressable accessibilityLabel={`Play [${c.n}] ${c.speaker} at ${stamp}`}` showing `[n] Speaker · m:ss` (`provenanceLabel` from `ItemProvenance.tsx` for the stamp) → `navigation.navigate('Meeting', { meetingId, tab: 'transcript', atMs: c.startMs })`; a `nothing` answer shows the phrase in `inkSoft` over "Closest passages" chips. Bottom: `TextInput placeholder="Ask this meeting…"` + `Pressable accessibilityLabel="Ask"`; while busy the button reads "Thinking…" and is disabled. `useEffect(() => () => { Llm.unload().catch(() => {}); }, [])`. `queries.ts`: `asks: (meetingId) => Llm.asks(meetingId).then(JSON.parse)`, `ask: (meetingId, q) => Llm.ask(meetingId, q).then(JSON.parse)`.

- [ ] **Step 3: Route + header + icon + sheet row.** `MeetingScreen.test.tsx` may need `Llm` mocked if the header renders nothing new that calls it (it does not).

- [ ] **Step 4: Run** `AskScreen.test.tsx`, `MeetingScreen.test.tsx`, `tsc`, eslint. Mutation-check: `atMs` off (cite test fails); refusal not routed (paywall test fails); unload dropped. Commit — `git commit -m "feat(ask): the Ask screen — a thread of answers that point at the transcript"`

---

### Task 12: Gate, docs, memory, and tomorrow's phone list

- [ ] `scripts/gate.sh` all stages except device → green (`GATE_STAGES="types js scans mutations kotlin cpp"`); `test_embed` runs with `VERBALE_EMBED_GGUF` exported in the shell that runs the gate (document in `scripts/gate.sh`'s header comment).
- [ ] Device tests written now, run tomorrow: `NativePipelineTest.embedding_is_a_unit_vector` (load the embed model via `ModelCatalog.fileFor(ctx, "embed-bge-small")`, `assumeTrue` installed; embed two texts; unit length; near > far), `AudioDbTest`: `deleteMeeting` removes `search_vec` rows; `replaceUtterancesJson` clears `embedded_at`; `indexMinutes` no duplicate for a meeting with rule items; `unindexedCount`.
- [ ] Spec: add "Device verification" as an empty checklist headed *pending — Pixel not attached 16 Sep*; plan: no SHIPPED banner yet. `docs/NEXT.md` and the scorecard rows wait for the phone. Memory: `ask-and-semantic-search.md` (state, decisions taken alone, the checklist). Commit.
- [ ] **Tomorrow on the Pixel (Pro):** Settings → the two models install (37 MB shows); `scripts/device-verify.sh NativePipeline` and `AudioDb`; process the lead-example meeting → logcat `embedded N chunk(s)`; Search "push back" → the Rahul turn with "≈"; Ask "did we agree on a date for the proposal?" → an answer with `[1]`/`[2]` chips, tap → transcript at 0:06; Ask during narration → BUSY note; free tier → paywall; then the docs/scorecard/memory closing commit, and the founder pushes `main`.
