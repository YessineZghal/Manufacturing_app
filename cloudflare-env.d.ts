declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    AI?: Ai;
    WORKERS_AI_MODEL?: string;
    VLLM_URL?: string;
    VLLM_MODEL?: string;
    VLLM_API_KEY?: string;
    BUILD_REVISION?: string;
  }
}
