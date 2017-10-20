import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import * as babylon from 'babylon'

import { RootConfigurations, Language, Item } from './global';
import FileInfo from './FileInfo'

export interface LanguageOptions {
	preferImports: boolean
	groupImports: boolean
	omitFileExtensionFromPath: boolean
	omitIndexFileFromPath: boolean
	preferSingleQuotes: boolean
	removeSemiColons: boolean
	variableNamingConvention: 'camelCase' | 'snake_case' | 'lowercase' | 'none'
	predefinedVariableNames: object
	filteredFileNames: object
}

export default class JavaScript implements Language {
	private baseConfig: RootConfigurations
	private fileItemCache: Array<FileItem>
	private nodeItemCache: Array<NodeItem>

	constructor(baseConfig: RootConfigurations) {
		this.baseConfig = baseConfig
	}

	async getItems(document: vscode.TextDocument) {
		if (SUPPORTED_LANGUAGE.test(document.languageId) === false) {
			return null
		}

		let items: Array<Item>

		const documentFileInfo = new FileInfo(document.fileName)
		const documentIsJavaScript = JAVASCRIPT_FILE_EXTENSION.test(documentFileInfo.fileExtensionWithoutLeadingDot)

		if (!this.fileItemCache) {
			const fileLinks = await vscode.workspace.findFiles('**/*.*')

			this.fileItemCache = fileLinks
				.map(fileLink => new FileItem(new FileInfo(fileLink.fsPath), this.baseConfig.javascript))
		}

		const fileFilterRule = _.toPairs(this.baseConfig.javascript.filteredFileNames)
			.map((pair: Array<string>) => ({ documentPathPattern: new RegExp(pair[0]), filePathPattern: new RegExp(pair[1]) }))
			.find(rule => rule.documentPathPattern.test(documentFileInfo.fullPathForPOSIX))

		items = _.chain(this.fileItemCache)
			.reject(item => item.fileInfo.fullPath === documentFileInfo.fullPath) // Remove the current file
			.reject(item => documentIsJavaScript ? TYPESCRIPT_FILE_EXTENSION.test(item.fileInfo.fileExtensionWithoutLeadingDot) : false) // Remove TypeScript files as JavaScript does not recognize them anyway
			.filter(item => fileFilterRule ? fileFilterRule.filePathPattern.test(item.fileInfo.fullPathForPOSIX) : true)
			.uniq() // Remove duplicate files
			.forEach(item => item.updateSortablePath(documentFileInfo.directoryPath))
			.sortBy([ // Sort files by their path and name
				item => item.sortablePath,
				item => item.sortableName,
			])
			.value()

		const packageJsonPath = fp.join(vscode.workspace.rootPath, 'package.json')
		if (!this.nodeItemCache && fs.existsSync(packageJsonPath)) {
			const packageJson = require(packageJsonPath)

			this.nodeItemCache = _.chain([packageJson.devDependencies, packageJson.dependencies])
				.map(_.keys)
				.flatten<string>()
				.map(name => new NodeItem(name, this.baseConfig.javascript))
				.sortBy(item => item.name)
				.value()
		}

		items = items.concat(this.nodeItemCache || [])

		return items
	}

	async fixImport(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken) {
		if (SUPPORTED_LANGUAGE.test(document.languageId) === false) {
			return false
		}

		const actions: Array<(worker: vscode.TextEditorEdit) => void> = []

		const documentFileInfo = new FileInfo(document.fileName)

		class FilePath implements vscode.QuickPickItem {
			readonly label: string
			readonly description: string
			readonly fullPath: string

			constructor(fullPath: string, originalPath: string) {
				this.fullPath = fullPath

				const fileInfo = new FileInfo(fullPath)
				const relaPath = fileInfo.getRelativePath(documentFileInfo.directoryPath)
				const fileName = fp.basename(relaPath)
				const fileExtn = fp.extname(relaPath)
				const dirxName = _.last(fp.dirname(relaPath).split(/\\|\//))

				const relativePathWithoutDots = _.takeRightWhile(relaPath.split('/'), part => part !== '.' && part !== '..').join('/')
				const relativePathFromWorkspace = fullPath.substring(vscode.workspace.rootPath.length).replace(/\\/g, fp.posix.sep)
				this.description = _.trim(relativePathFromWorkspace.substring(0, relativePathFromWorkspace.length - relativePathWithoutDots.length), '/')

				if (fileName === ('index.' + documentFileInfo.fileExtensionWithoutLeadingDot) && originalPath.endsWith(dirxName)) {
					this.label = relaPath.substring(0, relaPath.length - fileName.length - 1)

				} else if (originalPath.endsWith(fileExtn)) {
					this.label = relaPath

				} else {
					this.label = relaPath.substring(0, relaPath.length - fileExtn.length)
				}
			}
		}

		class ImportStatementForEditing {
			originalPath: string
			matchingPath: FilePath[] = []
			editableRange: vscode.Range
			quoteChar: string = '"'

			constructor(path: string, loc: { start: { line: number, column: number }, end: { line: number, column: number } }) {
				this.originalPath = path
				this.editableRange = new vscode.Range(loc.start.line - 1, loc.start.column, loc.end.line - 1, loc.end.column)

				const originalText = document.getText(this.editableRange)
				if (originalText.startsWith('\'')) {
					this.quoteChar = '\''
				}
			}
		}

		const codeTree = JavaScript.parse(document.getText())

		const totalImports = _.flatten([
			_.chain(codeTree.program.body)
				.filter(node =>
					node.type === 'ImportDeclaration' &&
					node.source.value.startsWith('.') &&
					node.source.value.includes('?') === false &&
					node.source.value.includes('!') === false &&
					node.source.value.includes('"') === false
				)
				.map((node: any) => new ImportStatementForEditing(node.source.value, node.source.loc))
				.value(),
			_.chain(findRequireRecursively(codeTree.program.body))
				.filter(node => node.arguments[0].value.startsWith('.'))
				.map(node => new ImportStatementForEditing(node.arguments[0].value, node.arguments[0].loc))
				.value(),
		]).filter(item => item.originalPath)

		const invalidImports = totalImports.filter(item =>
			fs.existsSync(fp.join(documentFileInfo.directoryPath, item.originalPath)) === false &&
			fs.existsSync(fp.join(documentFileInfo.directoryPath, item.originalPath + '.' + documentFileInfo.fileExtensionWithoutLeadingDot)) === false
		)

		if (invalidImports.length === 0) {
			vscode.window.setStatusBarMessage('Code Quicken: No broken import/require statements have been found.', 5000)
			return null
		}

		for (const item of invalidImports) {
			if (cancellationToken.isCancellationRequested) {
				return null
			}

			const sourceFileName = _.last(item.originalPath.split(/\\|\//))
			const matchingImports = await findFilesRoughly(sourceFileName, documentFileInfo.fileExtensionWithoutLeadingDot)

			item.matchingPath = matchingImports.map(fullPath => new FilePath(fullPath, item.originalPath))

			if (item.matchingPath.length > 1) {
				// Given originalPath = '../../../abc/xyz.js'
				// Return originalPathList = ['abc', 'xyz'.js']
				const originalPathList = item.originalPath.split(/\\|\//).slice(0, -1).filter(pathUnit => pathUnit !== '.' && pathUnit !== '..')

				let count = 0
				while (++count <= originalPathList.length) {
					const refinedPath = item.matchingPath.filter(path =>
						path.fullPath.split(/\\|\//).slice(0, -1).slice(-count).join('|') === originalPathList.slice(-count).join('|')
					)
					if (refinedPath.length === 1) {
						item.matchingPath = refinedPath
						break
					}
				}
			}
		}

		if (cancellationToken.isCancellationRequested) {
			return null
		}

		const unresolvedImports = invalidImports.filter(item => item.matchingPath.length !== 1)
		const resolvableImports = unresolvedImports.filter(item => item.matchingPath.length > 1)

		for (const item of resolvableImports) {
			const selectedPath = await vscode.window.showQuickPick(
				item.matchingPath,
				{ placeHolder: item.originalPath }
			)

			if (!selectedPath) {
				return null
			}

			if (cancellationToken.isCancellationRequested) {
				return null
			}

			await editor.edit(worker => {
				const span = item.editableRange
				const path = `${item.quoteChar}${selectedPath.label}${item.quoteChar}`
				worker.replace(span, path)
			})

			_.pull(unresolvedImports, item)
		}

		if (cancellationToken.isCancellationRequested) {
			return null
		}

		if (unresolvedImports.length === 0) {
			vscode.window.setStatusBarMessage('All broken import/require statements have been fixed.', 5000)

		} else {
			vscode.window.showWarningMessage(`Code Quicken: There ${unresolvedImports.length === 1 ? 'was' : 'were'} ${unresolvedImports.length} broken import/require statement${unresolvedImports.length === 1 ? '' : 's'} that had not been fixed.\n` + unresolvedImports.map(item => item.originalPath).join('\n'))
		}

		for (const item of invalidImports) {
			if (item.matchingPath.length === 1) {
				await editor.edit(worker => {
					const span = item.editableRange
					const path = `${item.quoteChar}${item.matchingPath[0].label}${item.quoteChar}`
					worker.replace(span, path)
				})
			}
		}

		return true
	}

	reset() {
		this.fileItemCache = null
		this.nodeItemCache = null
	}

	static parse(code: string) {
		try {
			return babylon.parse(code, {
				sourceType: 'module',
				plugins: [
					'jsx',
					'flow',
					'doExpressions',
					'objectRestSpread',
					'decorators',
					'classProperties',
					'exportExtensions',
					'asyncGenerators',
					'functionBind',
					'functionSent',
					'dynamicImport'
				]
			})

		} catch (ex) {
			console.error(ex)
			return null
		}
	}
}

class FileItem implements Item {
	private options: LanguageOptions
	readonly id: string
	readonly label: string
	readonly description: string
	fileInfo: FileInfo
	sortablePath: string
	sortableName: string

	constructor(fileInfo: FileInfo, options: LanguageOptions) {
		this.id = fileInfo.fullPath
		this.options = options
		this.fileInfo = fileInfo

		if (this.options.omitIndexFileFromPath && this.fileInfo.fileNameWithoutExtension === 'index') {
			this.label = this.fileInfo.directoryName
		} else if (this.options.omitFileExtensionFromPath) {
			this.label = this.fileInfo.fileNameWithoutExtension
		} else {
			this.label = this.fileInfo.fileNameWithExtension
		}

		// Set containing directory of the given file
		this.description = _.trim(fp.dirname(this.fileInfo.fullPath.substring(vscode.workspace.rootPath.length)), fp.sep)

		// Set sorting rank according to the file name
		if (this.fileInfo.fileNameWithoutExtension === 'index') {
			// Make index file appear on the top of its directory
			this.sortableName = '!'
		} else {
			this.sortableName = this.fileInfo.fileNameWithExtension.toLowerCase()
		}
	}

	updateSortablePath(directoryPathOfWorkingDocument: string) {
		// Set sorting rank according to the directory path
		// a = the opening files in VS Code
		// b = the files that are located in the same directory of the working document
		// cez = "./dir/file"
		// fd = "../file"
		// fez = "../dir/file"
		// ffd = "../../file"
		if (vscode.workspace.textDocuments.find(document => document.fileName === this.fileInfo.fullPath) !== undefined) {
			this.sortablePath = 'a'

		} else if (this.fileInfo.directoryPath === directoryPathOfWorkingDocument) {
			this.sortablePath = 'b'

		} else {
			this.sortablePath = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument).split('/').map((chunk, index, array) => {
				if (chunk === '.') return 'c'
				else if (chunk === '..') return 'f'
				else if (index === array.length - 1 && index > 0 && array[index - 1] === '..') return 'd'
				else if (index === array.length - 1) return 'z'
				return 'e'
			}).join('')
		}
	}

	async addImport(document: vscode.TextDocument) {
		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)

		const directoryPathOfWorkingDocument = new FileInfo(document.fileName).directoryPath

		let beforeFirstImport = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			beforeFirstImport = new vscode.Position(existingImports[0].start.line - 1, existingImports[0].start.column)
		}

		// For JS/TS, insert `import ... from "file.js" with rich features`
		// For CSS/LESS/SASS/SCSS/Styl, insert `import "file.css"`
		// Otherwise, insert `require("...")`
		if (JAVASCRIPT_FILE_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot) || TYPESCRIPT_FILE_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			// Set default imported variable name and its path
			let name = getVariableName(this.fileInfo.fileNameWithExtension, this.options)
			let path = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument)

			if (this.options.omitIndexFileFromPath && this.fileInfo.fileNameWithoutExtension === 'index') {
				// Set the imported variable name to the directory name
				name = getVariableName(this.fileInfo.directoryName, this.options)

				// Remove "/index.js" from the imported path
				path = fp.dirname(path)

			} else if (this.options.omitFileExtensionFromPath) {
				// Remove file extension from the imported path only if it matches the working document
				path = path.replace(new RegExp(_.escapeRegExp('\\.' + this.fileInfo.fileExtensionWithoutLeadingDot) + '$'), '')
			}

			let foundIndexFileAndWentForIt = false

			if (this.options.preferImports) {
				if (this.hasIndexFile()) {
					const exportedVariables = this.getExportedVariablesFromIndexFile()

					let indexFileRelativePath = new FileInfo(this.getIndexPath()).getRelativePath(directoryPathOfWorkingDocument)
					if (this.options.omitIndexFileFromPath) {
						indexFileRelativePath = fp.dirname(indexFileRelativePath)

					} else if (this.options.omitFileExtensionFromPath) {
						indexFileRelativePath = indexFileRelativePath.replace(new RegExp(_.escapeRegExp(fp.extname(indexFileRelativePath)) + '$'), '')
					}

					const duplicateImportForIndexFile = getDuplicateImport(existingImports, indexFileRelativePath)
					const duplicateImportHasImportedEverything = _.isMatch(duplicateImportForIndexFile, IMPORT_EVERYTHING)

					// Stop processing if there is `import * as name from "path"`
					if (exportedVariables.length > 0 && duplicateImportHasImportedEverything) {
						vscode.window.showInformationMessage(`The module "${name}" has been already imported from "${indexFileRelativePath}".`)
						// TODO: move focus to the statement
						return null
					}

					if (exportedVariables.length === 1) {
						// Set `import { name } from "path/index.js"` when the index file exports only one
						name = exportedVariables[0]
						name = `{ ${name} }`

						path = indexFileRelativePath

						foundIndexFileAndWentForIt = true

					} else if (exportedVariables.length > 1) {
						// Let the user choose between `import * as name from "path/index.js"` or `import { name } from "path/index.js"`
						const selectedName = await vscode.window.showQuickPick(['*', ...exportedVariables])

						if (!selectedName) {
							return null
						}

						if (selectedName === '*') {
							name = '* as ' + name
						} else {
							name = `{ ${selectedName} }`
						}

						path = indexFileRelativePath

						foundIndexFileAndWentForIt = true
					}
				}

				if (foundIndexFileAndWentForIt === false) {
					const codeText = fs.readFileSync(this.fileInfo.fullPath, 'utf-8')
					const codeTree = JavaScript.parse(codeText)

					const foreignFileHasDefaultExport = (
						codeTree === null ||
						findInCodeTree(codeTree, EXPORT_DEFAULT) !== undefined ||
						findInCodeTree(codeTree, MODULE_EXPORTS) !== undefined
					)

					if (foreignFileHasDefaultExport === false) {
						const exportedVariables = getExportedVariables(this.fileInfo.fullPath)
						if (exportedVariables.length === 0) {
							// Set `import * as name from "path"` when the file does not export anything
							name = '* as ' + name

						} else {
							// Let the user choose between `import * as name from "path"` or `import { name } from "path"`
							name = await vscode.window.showQuickPick(['*', ...exportedVariables])

							if (!name) {
								return null
							}

							if (name === '*') {
								name = '* as ' + name
							} else {
								name = `{ ${name} }`
							}
						}
					}
				}
			}

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				// Try merging named imports together
				// Note that we cannot merge with `import * as name from "path"`
				if (this.options.groupImports && duplicateImport.node.type === 'ImportDeclaration' && name.startsWith('*') === false) {
					const originalName = name.startsWith('{')
						? name.substring(1, name.length - 1).trim() // Remove brackets from `{ name }`
						: name

					let duplicateNamedImport = null
					const importedVariables = duplicateImport.node.specifiers as Array<any>
					for (let node of importedVariables) {
						if (node.type === 'ImportDefaultSpecifier' && name.startsWith('{') === false) { // In case of `import name from "path"`
							duplicateNamedImport = node
							break

						} else if (node.type === 'ImportSpecifier' && node.imported.name === originalName) { // In case of `import { name } from "path"`
							duplicateNamedImport = node
							break
						}
					}

					if (duplicateNamedImport) {
						vscode.window.showInformationMessage(`The module "${originalName}" has been already imported.`)
						// TODO: move focus to the statement
						return null
					}

					if (name.startsWith('{')) { // In case of `import { name } from "path"`
						const lastNamedImport = _.findLast(importedVariables, node => node.type === 'ImportSpecifier')
						if (lastNamedImport) {
							const afterLastName = new vscode.Position(lastNamedImport.loc.end.line - 1, lastNamedImport.loc.end.column)
							return (worker: vscode.TextEditorEdit) => worker.insert(afterLastName, ', ' + originalName)

						} else {
							const lastAnyImport = _.last(importedVariables)
							const afterLastName = new vscode.Position(lastAnyImport.loc.end.line - 1, lastAnyImport.loc.end.column)
							return (worker: vscode.TextEditorEdit) => worker.insert(afterLastName, ', ' + name)
						}

					} else { // In case of `import name from "path"`
						const beforeFirstName = new vscode.Position(duplicateImport.node.loc.start.line - 1, duplicateImport.node.loc.start.column + ('import '.length))
						return (worker: vscode.TextEditorEdit) => worker.insert(beforeFirstName, name + ', ')
					}

				} else {
					vscode.window.showInformationMessage(`The module "${name}" has been already imported.`)
					// TODO: move focus to the statement
					return null
				}
			}

			const snippet = getImportSnippet(name, path, this.options.preferImports, this.options, document)

			return (worker: vscode.TextEditorEdit) => worker.insert(beforeFirstImport, snippet)

		} else if (/^(css|less|sass|scss|styl)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const path = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument)

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				vscode.window.showInformationMessage(`The module "${this.label}" has been already imported.`)
				// TODO: move focus to the statement
				return null
			}

			const snippet = getImportSnippet(null, path, this.options.preferImports, this.options, document)

			return (worker: vscode.TextEditorEdit) => worker.insert(beforeFirstImport, snippet)

		} else {
			const path = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument)
			const snippet = getImportSnippet(null, path, false, this.options, document)

			return (worker: vscode.TextEditorEdit) => worker.insert(vscode.window.activeTextEditor.selection.active, snippet)
		}
	}

	private getIndexPath() {
		return fp.resolve(this.fileInfo.directoryPath, 'index.' + this.fileInfo.fileExtensionWithoutLeadingDot)
	}

	private hasIndexFile() {
		return fs.existsSync(this.getIndexPath())
	}

	private getExportedVariablesFromIndexFile() {
		try {
			const codeTree = JavaScript.parse(fs.readFileSync(this.getIndexPath(), 'utf-8'))

			const importedVariableSourceDict = codeTree.program.body.filter(node => node.type === 'ImportDeclaration')
				.reduce((hash, node: any) => {
					(node.specifiers || []).forEach(item => {
						if (item.type === 'ImportDefaultSpecifier') {
							hash[item.local.name] = fp.resolve(this.fileInfo.directoryPath, node.source.value)

						} else if (item.type === 'ImportSpecifier') {
							hash[item.imported.name] = fp.resolve(this.fileInfo.directoryPath, node.source.value)
						}
					})
					return hash
				}, {})

			const exportedVariableList = new Array<string>()
			const exportedVariableSourceDict = new Map<string, string>()
			const sourceExportedVariableDict = new Map<string, Array<string>>()

			function save(name: string, path: string) {
				if (!name || !path) return false

				exportedVariableList.push(name)
				exportedVariableSourceDict.set(name, path)
				if (sourceExportedVariableDict.has(path)) {
					sourceExportedVariableDict.get(path).push(name)
				} else {
					sourceExportedVariableDict.set(path, [name])
				}
			}

			codeTree.program.body.filter(node => node.type === 'ExportNamedDeclaration')
				.forEach((node: any) => {
					node.specifiers.forEach(item => {
						if (item => item.type === 'ExportSpecifier' && item.local && item.local.type === 'Identifier') {
							const name = item.local.name
							let path
							if (node.source) {
								path = getFilePathWithExtension(this.fileInfo.fileExtensionWithoutLeadingDot, this.fileInfo.directoryPath, node.source.value)
							} else {
								path = getFilePathWithExtension(this.fileInfo.fileExtensionWithoutLeadingDot, importedVariableSourceDict[name])
							}
							save(name, path)
						}
					})
				})

			codeTree.program.body.filter(node => node.type === 'ExportAllDeclaration')
				.forEach((node: any) => {
					const path = getFilePathWithExtension(this.fileInfo.fileExtensionWithoutLeadingDot, this.fileInfo.directoryPath, node.source.value)
					getExportedVariables(path).forEach(name => {
						save(name, path)
					})
				})

			if (this.fileInfo.fileNameWithoutExtension === 'index') {
				return exportedVariableList
			}

			if (sourceExportedVariableDict.has(this.fileInfo.fullPath)) {
				return sourceExportedVariableDict.get(this.fileInfo.fullPath)
			}

		} catch (ex) {
			console.error(ex)
		}

		return []
	}
}

class NodeItem implements Item {
	private options: LanguageOptions
	readonly id: string
	readonly label: string
	readonly description: string = ''
	readonly name: string
	readonly path: string

	constructor(name: string, options: LanguageOptions) {
		this.id = 'node://' + name
		this.label = name
		this.name = getVariableName(name, options)
		this.path = name

		this.options = options

		// Set version of the module as the description
		try {
			const packageJson = require(fp.join(vscode.workspace.rootPath, 'node_modules', name, 'package.json'))
			if (packageJson.version) {
				this.description = 'v' + packageJson.version
			}
		} catch (ex) { }
	}

	async addImport(document: vscode.TextDocument) {
		let name = this.name
		if (/typescript(react)?/.test(document.languageId)) {
			name = `* as ${name}`
		}

		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)
		if (existingImports.find(item => item.path === this.path)) {
			vscode.window.showInformationMessage(`The module "${this.path}" has been already imported.`)
			return null
		}

		let position = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			position = new vscode.Position(existingImports[0].start.line - 1, existingImports[0].start.column)
		}

		const snippet = getImportSnippet(name, this.path, this.options.preferImports, this.options, document)

		return (worker: vscode.TextEditorEdit) => worker.insert(position, snippet)
	}
}

const SUPPORTED_LANGUAGE = /^(java|type)script(react)?/

const JAVASCRIPT_FILE_EXTENSION = /^jsx?$/

const TYPESCRIPT_FILE_EXTENSION = /^tsx?$/

export const EXPORT_DEFAULT = { type: 'ExportDefaultDeclaration' }

export const MODULE_EXPORTS = {
	type: 'ExpressionStatement',
	expression: {
		type: 'AssignmentExpression',
		left: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'module' },
			property: { type: 'Identifier', name: 'exports' }
		}
	}
}

export const MODULE_REQUIRE = {
	type: 'VariableDeclarator',
	init: {
		type: 'CallExpression',
		callee: {
			type: 'Identifier',
			name: 'require'
		},
		arguments: [
			{ type: 'StringLiteral' }
		]
	}
}

export const MODULE_REQUIRE_IMMEDIATE = {
	type: 'ExpressionStatement',
	expression: {
		type: 'CallExpression',
		callee: {
			type: 'Identifier',
			name: 'require'
		}
	}
}

const IMPORT_EVERYTHING = {
	type: 'ImportDeclaration',
	specifiers: [
		{
			type: 'ImportNamespaceSpecifier'
		}
	]
}

interface ImportStatementForReadOnly {
	node: any,
	path: string,
	start: { line: number, column: number },
	end: { line: number, column: number },
}

function getExistingImports(codeTree: any) {
	let imports: ImportStatementForReadOnly[] = []
	if (codeTree && codeTree.program && codeTree.program.body) {
		// For `import '...'`
		//     `import name from '...'`
		//     `import { name } from '...'`
		imports = imports.concat(codeTree.program.body
			.filter((line: any) => line.type === 'ImportDeclaration' && line.source && line.source.type === 'StringLiteral')
			.map((stub: any) => ({
				node: stub,
				...stub.loc,
				path: _.trimEnd(stub.source.value, '/'),
			}))
		)

		// For `var name = require('...')`
		//     `var { name } = require('...')`
		imports = imports.concat(_.flatten(codeTree.program.body
			.filter((line: any) => line.type === 'VariableDeclaration')
			.map((line: any) => line.declarations
				.filter(stub => _.isMatch(stub, MODULE_REQUIRE))
				.map(stub => ({
					node: stub,
					...line.loc,
					path: stub.init.arguments[0].value,
				}))
			)
		))

		// For `require('...')`
		imports = imports.concat(codeTree.program.body
			.filter((stub: any) => _.isMatch(stub, MODULE_REQUIRE_IMMEDIATE) && stub.expression.arguments.length === 1)
			.map((stub: any) => ({
				node: stub,
				...stub.loc,
				path: stub.expression.arguments[0].value,
			}))
		)
	}
	return imports
}

function getVariableName(name: string, options: LanguageOptions) {
	const rules = _.toPairs(options.predefinedVariableNames)
		.map((pair: Array<string>) => ({
			inputPattern: new RegExp(pair[0]),
			output: pair[1],
		}))
	for (let rule of rules) {
		if (rule.inputPattern.test(name)) {
			return name.replace(rule.inputPattern, rule.output)
		}
	}

	// Strip starting digits
	name = name.replace(/^\d+/, '')

	if (options.variableNamingConvention === 'camelCase') {
		return _.camelCase(name)

	} else if (options.variableNamingConvention === 'snake_case') {
		return _.snakeCase(name)

	} else if (options.variableNamingConvention === 'lowercase') {
		return _.words(name).join('').toLowerCase()

	} else {
		return name.match(/[a-z_$1-9]/gi).join('')
	}
}

function getImportSnippet(name: string, path: string, useImport: boolean, options: LanguageOptions, document: vscode.TextDocument) {
	if (options.preferSingleQuotes) {
		path = `'${path}'`
	} else {
		path = `"${path}"`
	}

	const lineEnding = (options.removeSemiColons ? '' : ';') + (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')

	if (useImport) {
		if (name) {
			return `import ${name} from ${path}` + lineEnding
		} else {
			return `import ${path}` + lineEnding
		}

	} else {
		if (name) {
			return `const ${name} = require(${path})` + lineEnding
		} else {
			return `require(${path})`
		}
	}
}

function findInCodeTree(source: object, target: object) {
	if (source === null) {
		return undefined

	} else if (source['type'] === 'File' && source['program']) {
		return findInCodeTree(source['program'], target)

	} else if (_.isMatch(source, target)) {
		return source

	} else if (_.isArrayLike(source['body'])) {
		for (let index = 0; index < source['body'].length; index++) {
			const result = findInCodeTree(source['body'][index], target)
			if (result !== undefined) {
				return result
			}
		}
		return undefined

	} else if (_.isObject(source['body'])) {
		return findInCodeTree(source['body'], target)

	} else if (_.get(source, 'type', '').endsWith('Declaration') && _.has(source, 'declaration')) {
		return findInCodeTree(source['declaration'], target)

	} else if (_.get(source, 'type', '').endsWith('Declaration') && _.has(source, 'declarations') && _.isArray(source['declarations'])) {
		for (let index = 0; index < source['declarations'].length; index++) {
			const result = findInCodeTree(source['declarations'][index], target)
			if (result !== undefined) {
				return result
			}
		}
		return undefined

	} else {
		return undefined
	}
}

function getExportedVariables(filePath: string): Array<string> {
	const fileExtn = _.trimStart(fp.extname(filePath), '.')
	try {
		const codeTree = JavaScript.parse(fs.readFileSync(filePath, 'utf-8'))

		return _.chain(codeTree.program.body)
			.map((node: any) => {
				if (node.type === 'ExportNamedDeclaration') {
					if (node.declaration && node.declaration.type === 'FunctionDeclaration') {
						return node.declaration.id.name

					} else if (node.declaration && node.declaration.type === 'VariableDeclaration') {
						return node.declaration.declarations.map(item => item.id.name)

					} else if (node.specifiers) {
						return node.specifiers.map(item => item.exported ? item.exported.name : item.local.name)
					}

				} else if (node.type === 'ExportAllDeclaration' && node.source.value) {
					return getExportedVariables(getFilePathWithExtension(fileExtn, filePath, node.source.value))

				} else if (_.isMatch(node, MODULE_EXPORTS) && node.expression.right.type === 'ObjectExpression') {
					return node.expression.right.properties.map(item => item.key.name)
				}
			})
			.flatten()
			.compact()
			.reject(name => name === 'default')
			.value() as Array<string>

	} catch (ex) {
		console.error(ex)
	}

	return []
}

function getFilePathWithExtension(expectedFileExtension: string, ...path: string[]) {
	const filePath = fp.resolve(...path)

	if (fs.existsSync(filePath)) {
		return filePath
	}

	return filePath + '.' + expectedFileExtension
}

function getDuplicateImport(existingImports: Array<ImportStatementForReadOnly>, path: string) {
	return existingImports.find(stub => stub.path === path)
}

async function findFilesRoughly(fileName: string, fileExtn: string) {
	let list = await vscode.workspace.findFiles('**/' + fileName)

	if (fileName.endsWith('.' + fileExtn) === false) {
		list = list.concat(await vscode.workspace.findFiles('**/' + fileName + '.' + fileExtn))
		list = list.concat(await vscode.workspace.findFiles('**/' + fileName + '/index.' + fileExtn))
	}

	return list.map(item => item.fsPath)
}

function findRequireRecursively(node: any, results = [], visited = new Set()) {
	if (visited.has(node)) {
		return results

	} else {
		visited.add(node)
	}

	if (_.isArrayLike(node)) {
		_.forEach(node, stub => {
			findRequireRecursively(stub, results, visited)
		})

	} else if (_.isObject(node) && node.type !== undefined) {
		if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1 && node.arguments[0].type === 'StringLiteral') {
			results.push(node)
			return results
		}

		_.forEach(node, stub => {
			findRequireRecursively(stub, results, visited)
		})
	}

	return results
}
