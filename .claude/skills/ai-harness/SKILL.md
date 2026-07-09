```markdown
# ai-harness Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and conventions used in the `ai-harness` TypeScript codebase. It covers file naming, import/export styles, commit message conventions, and testing practices. By following these guidelines, you can contribute code that is consistent, maintainable, and easy to review.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `myUtility.ts`, `dataProcessor.ts`

### Import Style
- Use **relative imports** for modules within the codebase.
  - Example:
    ```typescript
    import { processData } from './dataProcessor';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In dataProcessor.ts
    export function processData(input: string): string {
      // ...
    }
    ```

### Commit Message Conventions
- Use **conventional commits** with a `fix` prefix for bug fixes.
- Keep commit messages concise (average: 42 characters).
  - Example:
    ```
    fix: correct data parsing in processData
    ```

## Workflows

### Writing and Running Tests
**Trigger:** When adding new features or fixing bugs  
**Command:** `/run-tests`

1. Create a test file named with the `.test.ts` suffix (e.g., `myUtility.test.ts`).
2. Write tests using the `vitest` framework.
3. Run tests using the Vitest CLI:
    ```bash
    npx vitest
    ```

### Adding a New Module
**Trigger:** When introducing new functionality  
**Command:** `/add-module`

1. Create a new TypeScript file using camelCase naming.
2. Implement your logic and use **named exports**.
3. Import other modules using **relative imports**.
4. Write a corresponding test file with the `.test.ts` suffix.
5. Commit your changes using a conventional commit message.

### Fixing a Bug
**Trigger:** When resolving a bug  
**Command:** `/fix-bug`

1. Identify and fix the bug in the relevant TypeScript file.
2. Update or add tests to cover the fix.
3. Commit your changes with a `fix:` prefix in the commit message.

## Testing Patterns

- All tests are written using the **vitest** framework.
- Test files are named with the `.test.ts` suffix and placed alongside the code they test.
- Example test file:
    ```typescript
    // myUtility.test.ts
    import { describe, it, expect } from 'vitest';
    import { myUtility } from './myUtility';

    describe('myUtility', () => {
      it('should process input correctly', () => {
        expect(myUtility('input')).toBe('expectedOutput');
      });
    });
    ```

## Commands
| Command      | Purpose                                   |
|--------------|-------------------------------------------|
| /run-tests   | Run all tests using Vitest                |
| /add-module  | Add a new module following conventions    |
| /fix-bug     | Fix a bug and commit with proper message  |
```
