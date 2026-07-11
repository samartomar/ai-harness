```markdown
# ai-harness Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `ai-harness` TypeScript codebase. You'll learn how to structure files, write imports and exports, follow commit message conventions, and implement and run tests using Vitest. This guide is ideal for contributors seeking to maintain consistency and quality in the project.

## Coding Conventions

### File Naming
- Use **kebab-case** for all file names.
  - **Example:**  
    ```
    ai-engine.ts
    data-processor.test.ts
    ```

### Import Style
- Use **relative imports** for referencing other modules.
  - **Example:**
    ```typescript
    import { processData } from './data-processor';
    ```

### Export Style
- Use **named exports** for all exported functions, types, or constants.
  - **Example:**
    ```typescript
    // In ai-engine.ts
    export function runEngine() { /* ... */ }
    export type EngineOptions = { /* ... */ };
    ```

### Commit Messages
- Follow **conventional commit** style.
- Use prefixes such as `test`, `ci`, etc.
- Keep commit messages concise (average ~46 characters).
  - **Examples:**
    ```
    test: add edge case for data processor
    ci: update workflow for node 18
    ```

## Workflows

### Testing Code
**Trigger:** When you want to run the test suite to verify code changes.
**Command:** `/test`

1. Ensure your code changes are saved.
2. Open a terminal at the project root.
3. Run the Vitest test suite:
    ```bash
    npx vitest
    ```
4. Review the output for passing and failing tests.

### Writing a Test
**Trigger:** When adding new functionality or fixing a bug.
**Command:** `/write-test`

1. Create a new test file named with the `.test.ts` suffix, using kebab-case.
    - Example: `feature-x.test.ts`
2. Write your test using Vitest syntax.
    ```typescript
    import { describe, it, expect } from 'vitest';
    import { featureX } from './feature-x';

    describe('featureX', () => {
      it('should return true for valid input', () => {
        expect(featureX('valid')).toBe(true);
      });
    });
    ```
3. Run `/test` to ensure your test passes.

## Testing Patterns

- **Framework:** [Vitest](https://vitest.dev/)
- **Test file pattern:** Files must be named `*.test.ts` and follow kebab-case.
- **Test structure:** Use `describe`, `it`, and `expect` from Vitest.
  - **Example:**
    ```typescript
    import { describe, it, expect } from 'vitest';
    import { myFunction } from './my-function';

    describe('myFunction', () => {
      it('should do something', () => {
        expect(myFunction()).toBeDefined();
      });
    });
    ```

## Commands

| Command      | Purpose                                 |
|--------------|-----------------------------------------|
| /test        | Run the full test suite with Vitest      |
| /write-test  | Create and run a new test file           |
```