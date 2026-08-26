function assertWellFormedNfc(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains malformed Unicode`);
      }
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      throw new TypeError(`${label} contains malformed Unicode`);
    }
  }
  if (value.normalize("NFC") !== value) {
    throw new TypeError(`${label} must already be NFC`);
  }
}

function assertStrictValue(value: unknown, label: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertWellFormedNfc(value, label);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} numbers must be finite and not negative zero`);
    }
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} is not strict JSON`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertStrictValue(value[index], `${label}[${String(index)}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertWellFormedNfc(key, `${label} key`);
    assertStrictValue(child, `${label}.${key}`);
  }
}

/**
 * JSON.parse deliberately keeps only the final duplicate object key. This
 * dependency-free scanner walks already syntax-validated JSON text so trust
 * boundaries can reject that ambiguity without pulling parser packages into
 * standalone projected runtimes.
 */
class DuplicateKeyScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.space();
    this.value();
    this.space();
    if (this.index !== this.text.length) throw new TypeError("invalid JSON");
  }

  private space(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;
      if (character === "\\") {
        this.index += 1;
        continue;
      }
      if (character === '"') {
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
    }
    throw new TypeError("invalid JSON string");
  }

  private object(): void {
    this.index += 1;
    this.space();
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      const key = this.string();
      if (keys.has(key)) throw new TypeError(`duplicate JSON object key: ${key}`);
      keys.add(key);
      this.space();
      if (this.text[this.index] !== ":") throw new TypeError("invalid JSON object");
      this.index += 1;
      this.space();
      this.value();
      this.space();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === "}") return;
      if (separator !== ",") throw new TypeError("invalid JSON object");
      this.space();
    }
  }

  private array(): void {
    this.index += 1;
    this.space();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.value();
      this.space();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === "]") return;
      if (separator !== ",") throw new TypeError("invalid JSON array");
      this.space();
    }
  }

  private value(): void {
    const character = this.text[this.index];
    if (character === "{") {
      this.object();
      return;
    }
    if (character === "[") {
      this.array();
      return;
    }
    if (character === '"') {
      this.string();
      return;
    }
    while (this.index < this.text.length && !/[\s,}\]]/.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }
}

/** Parse one dependency-free strict JSON object after the caller enforces its byte cap. */
export function parseNativeStrictJsonObjectV1(
  text: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`invalid JSON ${label}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} JSON root must be an object`);
  }
  new DuplicateKeyScanner(text).scan();
  assertStrictValue(parsed, label);
  return parsed as Record<string, unknown>;
}
