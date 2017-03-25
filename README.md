# Haste

**Haste** is a powerful **VS Code** extension for creating file-based snippets, such as `import` and `require` statements in JavaScript.

This extension is heavily inspired by [**Quick Require**](https://marketplace.visualstudio.com/items?itemName=milkmidi.vs-code-quick-require), but it is written from scratch because the latter one supported only `import` and `require` in JavaScript and could not be customized at all. For example, in some JavaScript convention, you might want to omit the JavaScript file extension (`.js`) and the semi-colon (`;`) at the end of the line, hence it becomes `import MyFile from './MyFile'`.

You can also create a snippet for other languages as well, such as `@import './MyDesign.styl'` in [Stylus](http://stylus-lang.com/docs/import.html).

## Basic usage

Simply press _Ctrl+Shift+I_ on your keyboard to list all macthing files, and choose one file that you would like to insert a snippet based on it.

\!\[feature X\]\(images/feature-x.png\)

Given the below settings, when pressing _Ctrl+Shift+I_, it will list all JavaScript files and insert a snippet `import MyFile from './MyFile.js';` before your first import statement. As you can see, `path` is a glob pattern matching all JavaScript files recusively, `code` is an ES6 template string (actually, it will be passed onto [lodash's template function](https://lodash.com/docs/4.17.4#template)), and `insertAt` represents the position of the code to be inserted.

```
"haste.files": [
  {
    "path": "**/*.js",
    "code": "import ${selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n",
    "insertAt": "beforeFirstImport"
  }
]
```

## Working with multiple file patterns

You can add multiple file patterns, so that it will insert one snippet for one kind of file, while it will insert another snippet for a different kind of file. Let's say you want to import another `js` and `css` files into a JavaScript file, choosing `MyFile.js` will insert `import MyFile from './MyFile.js';`, while choosing `MyDesign.css` will insert `import './MyDesign.css';`.

```
"haste.files": [
  {
    "path": "**/*.js",
    "code": "import ${selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n"
  },
  {
    "path": "**/*.css",
    "code": "import '${selectFilePath}';\n"
  }
]
```

## Working with one file in different context

Supposed you want to import one file to two different kind of files, such as importing `MyDesign.css` to both `MyFile.js` and `ChrisDesign.css`. You need two patterns which share the same `path`, but specifying when to use which pattern in `when` expression.

```
"haste.files": [
  {
    "path": "**/*.css",
    "when": "activeFileInfo.fileExtensionWithoutLeadingDot === 'js'",
    "code": "import ${selectFilePath};\n"
  },
  {
    "path": "**/*.css",
    "when": "activeFileInfo.fileExtensionWithoutLeadingDot === 'css'",
    "code": "@import '${selectFilePath}';\n"
  }
]
```

## Perks of JavaScript _(and TypeScript too)_

When importing JavaScript files, the extension will genuinely check if the chosen file has been imported already. This prevents duplicate import statements.

// Insert GIF here

The extension also checks if the importing JavaScript file has `export default` or `module.exports`, so that you can use a variable `selectFileHasDefaultExport` in `code` setting.

```
"haste.files": [
  {
    "path": "**/*.js",
    "code": "import ${selectFileHasDefaultExport ? '' : '* as '}${selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n"
  }
]
```

Instead of writting `import MySuite from './MySuite/index.js';`, you can write `import MySuite from './MySuite';` without specifying `index.js`. This is also possible by turning `omitIndexInSelectFilePath` setting to `true`.

```
"haste.files": [
  {
    "path": "**/*.js",
    "code": "import ${selectFileInfo.fileNameWithExtension === 'index.js' ? selectFileInfo.directoryName : selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n",
    "omitIndexInSelectFilePath": true
  }
]
```

## Working with **Node.js**

Furthermore, this extension also supports **Node.js** module snippets. The below is the default for `haste.nodes` setting. Since some node modules contain one or more dashes (`-`), which cannot be used in a JavaScript variable, a helping function `getProperVariableName()` can sanitize it. For example, `react-dom` will become `import reactDom from 'react-dom';`.

```
"haste.nodes": {
  {
    "name": "*",
    "code": "import ${getProperVariableName(moduleName)} from '${moduleName}';\n"
  }
}
```

## File settings

```
"haste.files": [
  {
    "path": string | string[],
    "when": string,
    "code": string | string[],
    "omitIndexInSelectFilePath": boolean,
    "omitExtensionInSelectFilePath": boolean | string,
    "insertAt": string
  },
  ...
]
```

- `path`: a [glob pattern](https://www.npmjs.com/package/glob#glob-primer) of files to be listed in the quick pick.  
Specifying an exclamation mark (`!`) in front of the pattern will exclude those files from the list.
	```
	// This shows every JavaScript files
	"haste.files": [
	  {
		"path": "**/*.js",
		"code": "import ${selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n"
	  }
	]
	```
	```
	// This shows every JavaScript files, except ones in "node_modules" folder
	"haste.files": [
	  {
		"path": ["**/*.js", "!node_modules"],
		"code": "import ${selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n"
	  }
	]
	```

- `when`: a JavaScript boolean expression to control when this pattern is available against the current viewing document.  
You may use one or more following pre-defined variables:
  - `_` as **[lodash](https://www.npmjs.com/package/lodash)**.
  - `minimatch` as **[minimatch](https://www.npmjs.com/package/minimatch)**.
  - `path` as **Node.js**' [path](https://nodejs.org/api/path.html).
  - `activeDocument` as [vscode.window.activeTextEditor.document](https://code.visualstudio.com/docs/extensionAPI/vscode-api#TextDocument).
  - `activeFileInfo` as [FileInfo](#fileinfo-properties) object of the current viewing document.
	```
	// This shows every JavaScript files when the current viewing file name does not end with ".spec"
	"haste.files": [
	  {
		"path": "**/*.js",
		"when": "activeFileInfo.fileNameWithoutExtension.endsWith('.spec') === false",
		"code": "import ${selectFileInfo.fileNameWithoutExtension} from '${selectFilePath}';\n"
	  }
	]
	```

- `code`: an ES6 template string to be inserted to the current viewing document.  
You may use one or more following pre-defined variables:
  - `activeDocument` as [vscode.window.activeTextEditor.document](https://code.visualstudio.com/docs/extensionAPI/vscode-api#TextDocument).
  - `activeFileInfo` as [FileInfo](#fileinfo-properties) object of the current viewing document.
  - `selectFileInfo` as [FileInfo](#fileinfo-properties) object of the chosen file.
  - `selectFilePath` as a normalized _relative file path_ of the chosen file. This has `./` at the beginning if and only if the chosen file and the current viewing document are in the same folder. This can be used safely in JavaScript `import` statement.
  - `selectCodeText` as a whole text of the chosen file.
  - `selectCodeTree` as a parsed **[Babylon](https://www.npmjs.com/package/babylon)** object of the chosen file.
  - `selectFileHasDefaultExport` as boolean that is `true` when the chosen file has `export default` or `module.exports`, otherwise `false`.
  - `_` as **[lodash](https://www.npmjs.com/package/lodash)**.
  - `minimatch` as **[minimatch](https://www.npmjs.com/package/minimatch)**.
  - `path` as **Node.js**' [path](https://nodejs.org/api/path.html).
  - `getProperVariableName(string)` as a helping function that sanitizes the input string to a proper JavaScript variable name, such as `react-dom` to `reactDom`.
  - `findInCodeTree(codeTree, object)` as a helping function that returns `true` if and only if at least one branch in the given `codeTree` matches the given `object`, otherwise `false`.

- `omitIndexInSelectFilePath`: a boolean to control whether a file named `index` must not present in the variable `selectFilePath` of `code` setting.  
The default value is `false`.

- `omitExtensionInSelectFilePath`: a boolean or glob pattern of file extensions to remove from `selectFilePath` variable of `code` setting.  
Specifying `true` will strip all extension from `selectFilePath` variable of `code` setting.  
The default value is `false`.

- `insertAt`: a position of code to be inserted to the current viewing document.  
The possible values are: `"beforeFirstImport"`, `"afterLastImport"`, `"top"`, `"bottom"`, `"cursor"`.  
The default value is `cursor`.

## Node module settings

```
"haste.nodes": [
  {
    "name": string,
    "code": string | string[],
    "insertAt": string
  },
  ...
]
```

- `name`: a [glob pattern](https://www.npmjs.com/package/glob#glob-primer) of node module name.  
	```
	// This shows every node module that starts with `react`
	"haste.files": [
	  {
		"path": "react*",
		"code": "import ${getProperVariableName(moduleName)} from '${selectFilePath}';\n"
	  }
	]
	```

- `code`: an ES6 template string to be inserted to the current viewing document.  
You may use one or more following pre-defined variables:
  - `activeDocument` as [vscode.window.activeTextEditor.document](https://code.visualstudio.com/docs/extensionAPI/vscode-api#TextDocument).
  - `activeFileInfo` as [FileInfo](#fileinfo-properties) object of the current viewing document.
  - `moduleName` as the name of the select node module.
  - `moduleVersion` as a version written in _package.json_ inside the select node module.
  - `_` as [lodash](https://www.npmjs.com/package/lodash).
  - `minimatch` as [minimatch](https://www.npmjs.com/package/minimatch).
  - `path` as [path](https://nodejs.org/api/path.html).
  - `getProperVariableName(string)` as a helping function that sanitizes the input string to a proper JavaScript variable name, such as `react-dom` to `reactDom`.

- `insertAt`: a position of code to be inserted to the current viewing document.  
This is similar to [File settings](#file-settings).

## JavaScript parser settings

This extension uses **[Babylon](https://www.npmjs.com/package/babylon)** as a JavaScript parser, so it can detect `import` and `export` keywords. You may find the possible values for the plug-in names from [here](https://www.npmjs.com/package/babylon#plugins). The default value is showing below.

```
"haste.javascript.parser.plugins": [
  "classProperties",
  "objectRestSpread",
  "exportExtensions",
  "asyncGenerators",
  "functionBind"
]
```

## **FileInfo** object

**FileInfo** is an object instance containing path-file-extension information.

- `localPath`: a string represents path in the current operating system. For example, `c:\user\MyFile.js` in Windows, and `/c/user/MyFile.js` in Unix-like. 
- `unixPath`: a string represents path in Unix-like operating system.
- `fileNameWithExtension`
- `fileNameWithoutExtension`
- `fileExtensionWithoutLeadingDot`
- `directoryPath`: a string represents series of directories to the path.
- `directoryName`: a string represents only the containing directory to the path.

For example, if you are working with **React**, you need to add `"jsx"` as one of the plug-ins, so this extension is able to work smoothly.

## Release Notes

### 0.0.1
- Initial release
