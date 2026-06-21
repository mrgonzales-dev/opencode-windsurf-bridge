/**
 * Model enums (protobuf values) for the Windsurf plugin.
 *
 * These numeric enum values are extracted from Windsurf's extension.js.
 * To discover values yourself:
 *   1. Find: /Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
 *   2. Search: grep -oE 'CLAUDE[A-Z0-9_]+\s*=\s*[0-9]+' extension.js
 *
 * NOTE: Only ModelEnum + ModelEnumValue are exported here. All old types
 * (FirebaseAuthData, WindsurfAccount, CascadeSession, etc.) were dead code
 * from the pre-v0.3 architecture and have been removed.
 */

export const ModelEnum = {
  MODEL_UNSPECIFIED: 0,

  // ============================================================================
  // Claude Models
  // ============================================================================
  CLAUDE_3_OPUS_20240229: 63,
  CLAUDE_3_SONNET_20240229: 64,
  CLAUDE_3_HAIKU_20240307: 172,
  CLAUDE_3_5_SONNET_20240620: 80,
  CLAUDE_3_5_SONNET_20241022: 166,
  CLAUDE_3_5_HAIKU_20241022: 171,
  CLAUDE_3_7_SONNET_20250219: 226,
  CLAUDE_3_7_SONNET_20250219_THINKING: 227,
  CLAUDE_4_OPUS: 290,
  CLAUDE_4_OPUS_THINKING: 291,
  CLAUDE_4_SONNET: 281,
  CLAUDE_4_SONNET_THINKING: 282,
  CLAUDE_4_1_OPUS: 328,
  CLAUDE_4_1_OPUS_THINKING: 329,
  CLAUDE_4_5_SONNET: 353,
  CLAUDE_4_5_SONNET_THINKING: 354,
  CLAUDE_4_5_SONNET_1M: 370,
  CLAUDE_4_5_OPUS: 391,
  CLAUDE_4_5_OPUS_THINKING: 392,
  CLAUDE_CODE: 344,

  // ============================================================================
  // GPT Models
  // ============================================================================
  GPT_4: 30,
  GPT_4_1106_PREVIEW: 37,
  GPT_4O_2024_05_13: 71,
  GPT_4O_2024_08_06: 109,
  GPT_4O_MINI_2024_07_18: 113,
  GPT_4_5: 228,
  GPT_4_1_2025_04_14: 259,
  GPT_4_1_MINI_2025_04_14: 260,
  GPT_4_1_NANO_2025_04_14: 261,
  GPT_5_NANO: 337,
  GPT_5_MINIMAL: 338,
  GPT_5_LOW: 339,
  GPT_5: 340,
  GPT_5_HIGH: 341,
  GPT_5_CODEX: 346,
  // GPT 5.1 Codex variants
  GPT_5_1_CODEX_MINI_LOW: 385,
  GPT_5_1_CODEX_MINI_MEDIUM: 386,
  GPT_5_1_CODEX_MINI_HIGH: 387,
  GPT_5_1_CODEX_LOW: 388,
  GPT_5_1_CODEX_MEDIUM: 389,
  GPT_5_1_CODEX_HIGH: 390,
  GPT_5_1_CODEX_MAX_LOW: 395,
  GPT_5_1_CODEX_MAX_MEDIUM: 396,
  GPT_5_1_CODEX_MAX_HIGH: 397,
  // GPT 5.2 variants
  GPT_5_2_NONE: 399,
  GPT_5_2_LOW: 400,
  GPT_5_2_MEDIUM: 401,
  GPT_5_2_HIGH: 402,
  GPT_5_2_XHIGH: 403,
  GPT_5_2_NONE_PRIORITY: 404,
  GPT_5_2_LOW_PRIORITY: 405,
  GPT_5_2_MEDIUM_PRIORITY: 406,
  GPT_5_2_HIGH_PRIORITY: 407,
  GPT_5_2_XHIGH_PRIORITY: 408,

  // ============================================================================
  // O-Series (OpenAI Reasoning)
  // ============================================================================
  O1_PREVIEW: 117,
  O1_MINI: 118,
  O1: 170,
  O3_MINI: 207,
  O3_MINI_LOW: 213,
  O3_MINI_HIGH: 214,
  O3: 218,
  O3_LOW: 262,
  O3_HIGH: 263,
  O3_PRO: 294,
  O3_PRO_LOW: 295,
  O3_PRO_HIGH: 296,
  O4_MINI: 264,
  O4_MINI_LOW: 265,
  O4_MINI_HIGH: 266,

  // ============================================================================
  // Google Gemini
  // ============================================================================
  GEMINI_1_0_PRO: 61,
  GEMINI_1_5_PRO: 62,
  GEMINI_2_0_FLASH: 184,
  GEMINI_2_5_PRO: 246,
  GEMINI_2_5_FLASH: 312,
  GEMINI_2_5_FLASH_THINKING: 313,
  GEMINI_2_5_FLASH_LITE: 343,
  GEMINI_3_0_PRO_LOW: 378,
  GEMINI_3_0_PRO_HIGH: 379,
  GEMINI_3_0_PRO_MINIMAL: 411,
  GEMINI_3_0_PRO_MEDIUM: 412,
  GEMINI_3_0_FLASH_MINIMAL: 413,
  GEMINI_3_0_FLASH_LOW: 414,
  GEMINI_3_0_FLASH_MEDIUM: 415,
  GEMINI_3_0_FLASH_HIGH: 416,

  // ============================================================================
  // DeepSeek
  // ============================================================================
  DEEPSEEK_V3: 205,
  DEEPSEEK_R1: 206,
  DEEPSEEK_R1_SLOW: 215,
  DEEPSEEK_R1_FAST: 216,
  DEEPSEEK_V3_2: 409,

  // ============================================================================
  // Llama
  // ============================================================================
  LLAMA_3_1_8B_INSTRUCT: 106,
  LLAMA_3_1_70B_INSTRUCT: 107,
  LLAMA_3_1_405B_INSTRUCT: 105,
  LLAMA_3_3_70B_INSTRUCT: 208,
  LLAMA_3_3_70B_INSTRUCT_R1: 209,

  // ============================================================================
  // Qwen
  // ============================================================================
  QWEN_2_5_7B_INSTRUCT: 178,
  QWEN_2_5_32B_INSTRUCT: 179,
  QWEN_2_5_72B_INSTRUCT: 180,
  QWEN_2_5_32B_INSTRUCT_R1: 224,
  QWEN_3_235B_INSTRUCT: 324,
  QWEN_3_CODER_480B_INSTRUCT: 325,
  QWEN_3_CODER_480B_INSTRUCT_FAST: 327,

  // ============================================================================
  // XAI Grok
  // ============================================================================
  GROK_2: 212,
  GROK_3: 217,
  GROK_3_MINI_REASONING: 234,
  GROK_CODE_FAST: 345,

  // ============================================================================
  // Other Models
  // ============================================================================
  MISTRAL_7B: 77,
  KIMI_K2: 323,
  KIMI_K2_THINKING: 394,
  GLM_4_5: 342,
  GLM_4_5_FAST: 352,
  GLM_4_6: 356,
  GLM_4_6_FAST: 357,
  GLM_4_7: 417,
  GLM_4_7_FAST: 418,
  MINIMAX_M2: 368,
  MINIMAX_M2_1: 419,
  SWE_1_5: 359,
  SWE_1_5_REDIRECT: 361,
  SWE_1_5_THINKING: 369,
  SWE_1_5_SLOW: 377,
  SWE_1_6: 420,
  SWE_1_6_FAST: 421,
  CLAUDE_4_5_SONNET_THINKING_1M: 371,

  // GPT-OSS open-weights
  GPT_OSS_120B: 326,

  // GPT 5.2 Codex variants (added in Windsurf 2.3.x)
  GPT_5_2_CODEX_LOW: 422,
  GPT_5_2_CODEX_MEDIUM: 423,
  GPT_5_2_CODEX_HIGH: 424,
  GPT_5_2_CODEX_XHIGH: 425,
  GPT_5_2_CODEX_LOW_PRIORITY: 426,
  GPT_5_2_CODEX_MEDIUM_PRIORITY: 427,
  GPT_5_2_CODEX_HIGH_PRIORITY: 428,
  GPT_5_2_CODEX_XHIGH_PRIORITY: 429,

  // ─── Enterprise / private model slots ──────────────────────────────────
  // Cognition assigns each enterprise customer up to 30 "PRIVATE" enum
  // slots that point at their account-specific model deployments.
  PRIVATE_1: 219,
  PRIVATE_2: 220,
  PRIVATE_3: 221,
  PRIVATE_4: 222,
  PRIVATE_5: 223,
  PRIVATE_6: 314,
  PRIVATE_7: 315,
  PRIVATE_8: 316,
  PRIVATE_9: 317,
  PRIVATE_10: 318,
  PRIVATE_11: 347,
  PRIVATE_12: 348,
  PRIVATE_13: 349,
  PRIVATE_14: 350,
  PRIVATE_15: 351,
  PRIVATE_16: 363,
  PRIVATE_17: 364,
  PRIVATE_18: 365,
  PRIVATE_19: 366,
  PRIVATE_20: 367,
  PRIVATE_21: 372,
  PRIVATE_22: 373,
  PRIVATE_23: 374,
  PRIVATE_24: 375,
  PRIVATE_25: 376,
  PRIVATE_26: 380,
  PRIVATE_27: 381,
  PRIVATE_28: 382,
  PRIVATE_29: 383,
  PRIVATE_30: 384,
} as const;

export type ModelEnumValue = (typeof ModelEnum)[keyof typeof ModelEnum];
