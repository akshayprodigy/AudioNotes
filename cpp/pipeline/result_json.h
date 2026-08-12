// Single serializer for PipelineResult so the C ABI and the CLI emit byte-identical JSON.
#pragma once
#include <string>

#include "pipeline/pipeline.h"

namespace audionotes {
std::string resultToJson(const PipelineResult& res, const std::string& error = "");
}
