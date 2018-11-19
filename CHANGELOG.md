### 2.5.1
- Fixed missing `export { named }` where `named` is not imported from another file.

### 2.5.0
- Added `codeQuicken.convertImport` command for JavaScript and TypeScript.

### 2.4.2
- Added ability to place a named import in alphabetically order.
- Added ability to place a named import with a new line according to its surrounding.

### 2.4.1
- Fixed error populating the import/require list because of the recently used items.

### 2.4.0
- Added support of **@types** definitions for JavaScript and TypeScript.
- Added support of [Yarn Workspaces](https://yarnpkg.com/lang/en/docs/workspaces/).
- Amended the import/require list so it shows the recently used items when no search words.
- Amended `codeQuicken.history` setting so it has the default of 20.
- Fixed clearing node module cache automatically.

### 2.3.4
- Fixed missing re-exported named identifiers such `export { named } from "path"` for JavaScript and TypeScript.

### 2.3.3
- Fixed wrong insertion position for `require(...)`.
- Fixed unexpectedly showing selections for default import only.

### 2.3.2
- Fixed alphabetical order of imports for JavaScript and TypeScript.

### 2.3.1
- Amended never asking to choose between import namespace and default for JavaScript and TypeScript.
- Fixed alphabetical order of imports for JavaScript and TypeScript.

### 2.3.0
- Added duplicate identifier resolution dialog for JavaScript and TypeScript.
- Amended alphabetical order of imports for JavaScript and TypeScript.

### 2.2.0
- Added support of `export enum named = ...`.
- Amended `codeQuicken.typescript.predefinedVariableNames` setting so it also borrows the values specified in `codeQuicken.javascript.predefinedVariableNames` setting.

### 2.1.1
- Amended importing internal files instead of index files for JavaScript and TypeScript.
- Fixed missing require index path for JavaScript and TypeScript.

### 2.1.0
- Added original export path and code preview to the import/require list for JavaScript and TypeScript.
- Added variable assignments for JSON files.
- Fixed wrong import/require path for non JS & CSS files.

### 2.0.0
- Added support of Node.js built-in APIs.
- Added support of reading `compilerOptions.esModuleInterop` and `compilerOptions.allowJs` from the local [`tsconfig.json`](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html).
- Added progress while populating files.
- Fixed zero-file issue for Stylus.
- Amended better support of JavaScript and TypeScript.
- Amended the settings of JavaScript and TypeScript.
- Removed `@types` modules from the import/require list for JavaScript and TypeScript.
- Removed `codeQuicken.typescript.syntax` setting as it will be `"import"` by default.

|Settings|Possible values|Default value|
|---|---|---|
|`codeQuicken.javascript.syntax`|From `"import"`/`"require"` to `"import"`/`"require"`/`"auto"`|From `"require"` to `"auto"`|
|`codeQuicken.javascript.fileExtension` and `codeQuicken.typescript.fileExtension`|No changes|From `true` to `false`|
|`codeQuicken.javascript.indexFile`|No changes|From `true` to `false`|
|`codeQuicken.javascript.quoteCharacter` and `codeQuicken.typescript.quoteCharacter`|From `true`/`false` to `"single"`/`"double"`/`"auto"`|From `true` to `"auto"`|
|`codeQuicken.javascript.semiColons` and `codeQuicken.typescript.semiColons`|From `true`/`false` to `"always"`/`"never"`/`"auto"`|From `true` to `"auto"`|

### 1.4.0
- Amended picking the closest `package.json` from the current active document.
- Fixed TypeScript compilation errors.

### 1.3.0
- Added TypeScript settings.

### 1.2.1
- Fixed index file path when fixing an import statement.
- Fixed Windows path separator.

### 1.2.0
- Fixed missing file path when fixing an import/require statement.
- Fixed wrong index file path.
- Added ability to run [`eslint.executeAutofix`](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) command.
- Added ability to replace the existing variable.

### 1.1.1
- Added support of **Visual Studio Code** 1.18.0.

### 1.1.0
- Added `"PascalCase"` option to the setting `codeQuicken.javascript.variableNamingConvention`.

### 1.0.1
- Fixed the issue of writing `import * as * from "...";` in JavaScript.
- Fixed the settings of `codeQuicken.javascript.fileExtension`, `codeQuicken.javascript.indexFile`, `codeQuicken.javascript.semiColons`, `codeQuicken.stylus.fileExtension`, `codeQuicken.stylus.indexFile`, and `codeQuicken.stylus.semiColons`.
- Amended ability to detect duplicate imports in JavaScript.
- Amended ability to replace named imports with namespace import in JavaScript.

### 1.0.0
- Amended the whole extension to only support inserting and fixing `import`/`require` statements in JavaScript, TypeScript, and Stylus languages.

### 0.0.10
- Fixed the unexpected reading Node-module require statements.

### 0.0.9
- Added ability to fix broken require statements.
- Added ability to manually fix the import/require statements when more than one path is matched.
- Added support of JavaScript, TypeScript and their React expansions.

### 0.0.8
- Added ability to read code template from a JavaScript file.
- Fixed the unexpected same behavior when running insert file/node/text commands.

### 0.0.7
- Fixed unable to filter in directory path.

### 0.0.6
- Public release.
