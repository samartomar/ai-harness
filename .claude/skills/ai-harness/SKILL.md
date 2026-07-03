```markdown
# ai-harness Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you how to contribute to the `ai-harness` TypeScript codebase, focusing on its coding conventions, commit patterns, and the main development workflows. You'll learn how to fix bugs, write and update tests, and perform releases using standardized processes and commands.

## Coding Conventions

- **Language:** TypeScript
- **Framework:** None detected
- **File Naming:** Use camelCase for file names.
  - Example: `workspaceManager.ts`
- **Import Style:** Use relative imports.
  - Example:
    ```typescript
    import { getWorkspace } from './workspaceManager'
    ```
- **Export Style:** Use named exports.
  - Example:
    ```typescript
    export function getWorkspace() { ... }
    ```
- **Commit Messages:** Follow conventional commit style with prefixes such as `test`, `fix`, and `chore`.
  - Example: `fix: handle edge case in workspace loading`

## Workflows

### Bugfix with Corresponding Tests
**Trigger:** When you need to fix a bug or harden logic in workspace or report modules.  
**Command:** `/fix-with-tests`

1. Edit one or more files in `src/workspace/` or `src/report/` to implement the fix.
2. Edit or add one or more files in `tests/workspace/` or `tests/report/` to add or update tests verifying the fix.
3. Use a conventional commit message, e.g., `fix: correct workspace path resolution`.
4. Example:
    ```typescript
    // src/workspace/loader.ts
    export function loadWorkspace(path: string) {
      if (!path) throw new Error('Path required')
      // ...rest of logic
    }
    ```
    ```typescript
    // tests/workspace/loader.test.ts
    import { loadWorkspace } from '../../src/workspace/loader'
    import { describe, it, expect } from 'vitest'

    describe('loadWorkspace', () => {
      it('throws if path is missing', () => {
        expect(() => loadWorkspace('')).toThrow()
      })
    })
    ```

### Test-Driven Repro Workflow
**Trigger:** When you want to add a test to reproduce a bug or validate a new scenario in workspace logic.  
**Command:** `/add-repro-test`

1. Edit or add one or more test files in `tests/workspace/` or `tests/report/` to cover a new scenario or bug.
2. Do **not** change any `src/` files in this commit.
3. Use a `test:` prefix in your commit message, e.g., `test: add repro for workspace config bug`.
4. Example:
    ```typescript
    // tests/workspace/config.test.ts
    import { getConfig } from '../../src/workspace/config'
    import { describe, it, expect } from 'vitest'

    describe('getConfig', () => {
      it('returns default config if none found', () => {
        expect(getConfig('nonexistent')).toEqual({ /* default config */ })
      })
    })
    ```

### Version Bump Release
**Trigger:** When you want to release a new version.  
**Command:** `/release`

1. Edit `package.json` and `package-lock.json` to update the version number.
2. Edit `CHANGELOG.md` to document the release.
3. Edit `src/program.ts` to update the version reference in the code.
4. Use a `chore:` prefix in your commit message, e.g., `chore: release v1.2.3`.
5. Example:
    ```json
    // package.json
    {
      "version": "1.2.3"
    }
    ```
    ```markdown
    <!-- CHANGELOG.md -->
    ## 1.2.3
    - Fixed workspace loading bug
    - Improved reporting logic
    ```
    ```typescript
    // src/program.ts
    export const VERSION = '1.2.3'
    ```

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test Files:** Use the `*.test.ts` pattern.
- **Location:** Tests are organized in `tests/workspace/` and `tests/report/`.
- **Example Test:**
    ```typescript
    import { someFunction } from '../../src/workspace/someFile'
    import { describe, it, expect } from 'vitest'

    describe('someFunction', () => {
      it('works as expected', () => {
        expect(someFunction()).toBe(true)
      })
    })
    ```

## Commands

| Command           | Purpose                                                      |
|-------------------|--------------------------------------------------------------|
| /fix-with-tests   | Fix a bug and add or update corresponding tests              |
| /add-repro-test   | Add a test to reproduce or validate a bug or edge case       |
| /release          | Bump version, update changelog, and prepare a new release    |
```