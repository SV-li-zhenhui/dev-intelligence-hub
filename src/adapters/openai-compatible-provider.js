const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const API_KEY = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const OPTION_KEYS = new Set([
  "id",
  "fetch",
  "baseUrl",
  "apiKeyEnv",
  "env",
  "environment",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
]);

export class OpenAICompatibleProviderError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerError(code, message, statusCode) {
  return new OpenAICompatibleProviderError(code, message, statusCode);
}

async function withinTimeout(controller, durationMs, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        providerError(
          "STRUCTURED_PROVIDER_TIMEOUT",
          "Structured provider request timed out",
          504,
        ),
      );
    }, durationMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function optionsObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !OPTION_KEYS.has(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw new TypeError("OpenAI-compatible provider options are invalid");
  }
  return value;
}

function safeId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError("provider id is invalid");
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the supported range`);
  }
  return value;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("OpenAI-compatible baseUrl is invalid");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError("OpenAI-compatible baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("OpenAI-compatible baseUrl must not contain userinfo");
  }
  if (url.search || url.hash) {
    throw new TypeError(
      "OpenAI-compatible baseUrl must not contain query or fragment",
    );
  }
  const remote = !isLoopback(url.hostname);
  if (remote && url.protocol !== "https:") {
    throw new TypeError("Remote endpoint must use HTTPS");
  }
  return {
    remote,
    requestUrl: `${url.toString().replace(/\/+$/, "")}/chat/completions`,
  };
}

function configuredApiKey(environment, name) {
  if (typeof name !== "string" || !SAFE_ENV_NAME.test(name)) {
    throw new TypeError("apiKeyEnv is invalid");
  }
  if (!environment || typeof environment !== "object") {
    throw new TypeError("injected environment is invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !API_KEY.test(descriptor.value)
  ) {
    throw new TypeError("OpenAI-compatible credential is unavailable");
  }
  return descriptor.value;
}

function safeText(value, name, maximumBytes) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeMessages(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 16
  ) {
    throw new TypeError("messages are invalid");
  }
  return value.map((message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      Object.getPrototypeOf(message) !== Object.prototype ||
      Reflect.ownKeys(message).length !== 2 ||
      !Object.hasOwn(message, "role") ||
      !Object.hasOwn(message, "content") ||
      !new Set(["system", "user", "assistant"]).has(message.role)
    ) {
      throw new TypeError("messages are invalid");
    }
    return {
      role: message.role,
      content: safeText(message.content, "message.content", 128 * 1024),
    };
  });
}

function normalizeSchema(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("schema is invalid");
  }
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError("schema is invalid");
  }
}

async function boundedResponseText(response, maximumBytes) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw providerError(
            "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
            "Structured provider response exceeds the configured limit",
            413,
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      if (error instanceof OpenAICompatibleProviderError) throw error;
      throw providerError(
        "STRUCTURED_PROVIDER_RESPONSE_INVALID",
        "Structured provider response is invalid",
        502,
      );
    }
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
      "Structured provider response exceeds the configured limit",
      413,
    );
  }
  return text;
}

function responseContent(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
  return content;
}

export class OpenAICompatibleProvider {
  #fetch;
  #requestUrl;
  #apiKey;
  #timeoutMs;
  #maxResponseBytes;
  #maxRequestBytes;

  constructor(rawOptions = {}) {
    const options = optionsObject(rawOptions);
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new TypeError("OpenAI-compatible provider requires fetch");
    }
    const target = endpoint(options.baseUrl);
    this.id = safeId(options.id ?? "openai-compatible");
    this.kind = "openai-compatible";
    this.remote = target.remote;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new TypeError("OpenAI-compatible provider requires fetch");
    }
    this.#requestUrl = target.requestUrl;
    if (options.env !== undefined && options.environment !== undefined) {
      throw new TypeError("injected environment is ambiguous");
    }
    const environment =
      options.env === undefined ? options.environment : options.env;
    this.#apiKey = configuredApiKey(environment, options.apiKeyEnv);
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      10,
      120_000,
    );
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      1_024,
      1024 * 1024,
    );
    this.#maxRequestBytes = boundedInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
      1_024,
      2 * 1024 * 1024,
    );
    Object.freeze(this);
  }

  async generate({ model, messages, schema } = {}) {
    const body = JSON.stringify({
      model: safeText(model, "model", 256),
      messages: normalizeMessages(messages),
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "work_decision",
          strict: true,
          schema: normalizeSchema(schema),
        },
      },
    });
    if (Buffer.byteLength(body, "utf8") > this.#maxRequestBytes) {
      throw providerError(
        "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE",
        "Structured provider request exceeds the configured limit",
        413,
      );
    }
    const controller = new AbortController();
    return withinTimeout(controller, this.#timeoutMs, async () => {
      try {
        let response;
        try {
          response = await this.#fetch(this.#requestUrl, {
            method: "POST",
            redirect: "error",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
            },
            body,
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) {
            throw providerError(
              "STRUCTURED_PROVIDER_TIMEOUT",
              "Structured provider request timed out",
              504,
            );
          }
          throw providerError(
            "STRUCTURED_PROVIDER_REQUEST_FAILED",
            "Structured provider request failed",
            502,
          );
        }
        if (!response?.ok) {
          throw providerError(
            "STRUCTURED_PROVIDER_HTTP_FAILED",
            `Structured provider request failed with HTTP ${Number(response?.status) || 0}`,
            502,
          );
        }
        return responseContent(
          await boundedResponseText(response, this.#maxResponseBytes),
        );
      } catch (error) {
        if (
          controller.signal.aborted &&
          error?.code !== "STRUCTURED_PROVIDER_TIMEOUT"
        ) {
          throw providerError(
            "STRUCTURED_PROVIDER_TIMEOUT",
            "Structured provider request timed out",
            504,
          );
        }
        throw error;
      }
    });
  }
}

export {
  OpenAICompatibleProvider as OpenAiCompatibleProvider,
  OpenAICompatibleProviderError as OpenAiCompatibleProviderError,
};
