### 1.2.0
- Fixed missing file path when fixing an import/require statement.

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
- Amended the whole extension to only support inserting and fixing `import`/`require` statements in JavaScript + TypeScript and Stylus languages.

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
