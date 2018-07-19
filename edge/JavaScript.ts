import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import * as ts from 'typescript'

import { RootConfigurations, Language, Item, getSortablePath, findFilesRoughly } from './global';
import FileInfo from './FileInfo'

export interface LanguageOptions {
	syntax: 'import' | 'require'
	grouping: boolean
	fileExtension: boolean
	indexFile: boolean
	quoteCharacter: 'single' | 'double' | 'auto'
	semiColons: 'always' | 'never' | 'auto'
	predefinedVariableNames: object
	variableNamingConvention: 'camelCase' | 'PascalCase' | 'snake_case' | 'lowercase' | 'none'
	filteredFileList: object
}

const SUPPORTED_EXTENSION = /^(j|t)sx?$/i

export default class JavaScript implements Language {
	protected baseConfig: RootConfigurations
	private fileItemCache: Array<FileItem>
	private nodeItemCache: Array<NodeItem>
	private packageWatch: vscode.FileSystemWatcher

	protected acceptedLanguage = /^javascript(react)?/

	constructor(baseConfig: RootConfigurations) {
		this.baseConfig = baseConfig

		this.packageWatch = vscode.workspace.createFileSystemWatcher('**/package.json')
		this.packageWatch.onDidCreate(() => {
			this.nodeItemCache = null
		})
		this.packageWatch.onDidChange(() => {
			this.nodeItemCache = null
		})
		this.packageWatch.onDidDelete(() => {
			this.nodeItemCache = null
		})
	}

	getLanguageOptions() {
		return this.baseConfig.javascript
	}

	async checkIfImportDefaultIsPreferredOverNamespace() {
		return true
	}

	async getItems(document: vscode.TextDocument) {
		if (this.acceptedLanguage.test(document.languageId) === false) {
			return null
		}

		const documentFileInfo = new FileInfo(document.fileName)
		const rootPath = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath

		if (!this.fileItemCache) {
			const fileLinks = await vscode.workspace.findFiles('**/*.*')

			this.fileItemCache = fileLinks
				.filter(await this.createFileFilter())
				.map(fileLink => new FileItem(fileLink.fsPath, rootPath, this))
		}

		const fileFilterRule = _.toPairs(this.getLanguageOptions().filteredFileList)
			.map((pair: Array<string>) => ({ documentPathPattern: new RegExp(pair[0]), filePathPattern: new RegExp(pair[1]) }))
			.find(rule => rule.documentPathPattern.test(documentFileInfo.fullPathForPOSIX))

		const filteredItems: Array<Item> = []
		for (const item of this.fileItemCache) {
			if (fileFilterRule && fileFilterRule.filePathPattern.test(item.fileInfo.fullPathForPOSIX) === false) {
				continue
			}

			if (item.fileInfo.fullPath === documentFileInfo.fullPath) {
				continue
			}

			item.sortablePath = getSortablePath(item.fileInfo, documentFileInfo)

			filteredItems.push(item)
		}

		// Sort files by their path and name
		const sortedItems = _.sortBy(filteredItems, [
			item => item.sortablePath,
			item => item.sortableName,
		])

		if (!this.nodeItemCache) {
			const packageJsonLinkList = await vscode.workspace.findFiles('**/package.json')
			let packageJson: any = {}
			if (packageJsonLinkList.length > 0) {
				const packageJsonPath = _.chain(packageJsonLinkList)
					.map(link => link.fsPath)
					.sortBy(path => -fp.dirname(path).split(fp.sep).length)
					.find(path => document.fileName.startsWith(fp.dirname(path) + fp.sep))
					.value()
				packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
			}

			const dependencies = _.chain([packageJson.devDependencies, packageJson.dependencies])
				.map(_.keys)
				.flatten()
				.value()

			let nodeJsAPIs: Array<NodeItem> = []
			if (dependencies.some(name => name === '@types/node')) {
				const nodeJsVersion = getLocalModuleVersion('@types/node', rootPath)
				nodeJsAPIs = getNodeJsAPIs(rootPath).map(name => new NodeItem(name, nodeJsVersion, this))
			}

			this.nodeItemCache = _.chain(dependencies)
				.reject(name => name.startsWith('@types/'))
				.map(name => new NodeItem(name, getLocalModuleVersion(name, rootPath), this))
				.concat(nodeJsAPIs)
				.sortBy(item => item.name)
				.value()
		}

		return [...sortedItems, ...(this.nodeItemCache || [])] as Array<Item>
	}

	addItem(filePath: string) {
		if (this.fileItemCache) {
			const rootPath = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)).uri.fsPath
			this.fileItemCache.push(new FileItem(filePath, rootPath, this))
		}
	}

	cutItem(filePath: string) {
		if (this.fileItemCache) {
			const fileInfo = new FileInfo(filePath)
			const index = this.fileItemCache.findIndex(item => item.fileInfo.fullPath === fileInfo.fullPath)
			if (index >= 0) {
				this.fileItemCache.splice(index, 1)
			}
		}
	}

	async fixImport(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken) {
		if (this.acceptedLanguage.test(document.languageId) === false) {
			return false
		}

		const documentFileInfo = new FileInfo(document.fileName)
		const rootPath = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath

		class ImportStatementForFixingImport {
			originalRelativePath: string
			editableRange: vscode.Range
			private matchingFullPaths: Array<string>

			constructor(path: string, start: number, end: number) {
				this.originalRelativePath = path
				this.editableRange = new vscode.Range(document.positionAt(start), document.positionAt(end))
			}

			get quoteChar() {
				const originalText = document.getText(this.editableRange)
				if (originalText.startsWith('\'')) {
					return '\''
				} else {
					return '"'
				}
			}

			async search() {
				if (this.matchingFullPaths === undefined) {
					this.matchingFullPaths = await findFilesRoughly(this.originalRelativePath, documentFileInfo.fileExtensionWithoutLeadingDot)
				}
				return this.matchingFullPaths
			}
		}

		class FileItemForFixingImport implements vscode.QuickPickItem {
			readonly label: string
			readonly description: string
			readonly fullPath: string

			constructor(fullPath: string) {
				this.fullPath = fullPath
				this.label = fullPath.substring(rootPath.length).replace(/\\/g, '/')
			}
		}

		const codeTree = JavaScript.parse(document.getText())

		const totalImports = _.flatten([
			codeTree.statements
				.filter(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
				.filter((node: ts.ImportDeclaration) => {
					const path = (node.moduleSpecifier as ts.StringLiteral).text
					return (
						path.startsWith('.') &&
						path.includes('?') === false &&
						path.includes('!') === false &&
						path.includes('"') === false
					)
				})
				.map((node: ts.ImportDeclaration) => new ImportStatementForFixingImport((node.moduleSpecifier as ts.StringLiteral).text, node.getStart(), node.getEnd())),
			findNodesRecursively<ts.CallExpression>(codeTree, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
				.filter(node => (node.arguments[0] as ts.StringLiteral).text.startsWith('.'))
				.map(node => new ImportStatementForFixingImport((node.arguments[0] as ts.StringLiteral).text, node.getStart(), node.getEnd())),
		]).filter(item => item.originalRelativePath)

		const brokenImports = totalImports.filter(item =>
			fs.existsSync(fp.join(documentFileInfo.directoryPath, item.originalRelativePath)) === false &&
			fs.existsSync(fp.join(documentFileInfo.directoryPath, item.originalRelativePath + '.' + documentFileInfo.fileExtensionWithoutLeadingDot)) === false
		)

		if (brokenImports.length === 0) {
			vscode.window.setStatusBarMessage('Code Quicken: No broken import/require statements have been found.', 5000)
			return null
		}

		const nonResolvableImports: Array<ImportStatementForFixingImport> = []
		const manualSolvableImports: Array<ImportStatementForFixingImport> = []
		for (const item of brokenImports) {
			if (cancellationToken.isCancellationRequested) {
				return null
			}

			const matchingFullPaths = await item.search()
			if (matchingFullPaths.length === 0) {
				nonResolvableImports.push(item)

			} else if (matchingFullPaths.length === 1) {
				await editor.edit(worker => {
					const { path } = new FileItem(matchingFullPaths[0], rootPath, this).getNameAndRelativePath(document)
					worker.replace(item.editableRange, `${item.quoteChar}${path}${item.quoteChar}`)
				})

			} else {
				manualSolvableImports.push(item)
			}
		}

		for (const item of manualSolvableImports) {
			const matchingFullPaths = await item.search()

			const candidateItems = matchingFullPaths.map(path => new FileItemForFixingImport(path))
			const selectedItem = await vscode.window.showQuickPick(candidateItems, { placeHolder: item.originalRelativePath, ignoreFocusOut: true })
			if (!selectedItem) {
				return null
			}

			if (cancellationToken.isCancellationRequested) {
				return null
			}

			await editor.edit(worker => {
				const { path } = new FileItem(selectedItem.fullPath, rootPath, this).getNameAndRelativePath(document)
				worker.replace(item.editableRange, `${item.quoteChar}${path}${item.quoteChar}`)
			})
		}

		await JavaScript.fixESLint()

		if (nonResolvableImports.length === 0) {
			vscode.window.setStatusBarMessage('Code Quicken: All broken import/require statements have been fixed.', 5000)

		} else {
			vscode.window.showWarningMessage(`Code Quicken: There ${nonResolvableImports.length === 1 ? 'was' : 'were'} ${nonResolvableImports.length} broken import/require statement${nonResolvableImports.length === 1 ? '' : 's'} that had not been fixed.`)
		}

		return true
	}

	reset() {
		this.fileItemCache = null
		this.nodeItemCache = null
		this.packageWatch.dispose()
	}

	protected async createFileFilter() {
		return (link: vscode.Uri) => true
	}

	static async fixESLint() {
		const commands = await vscode.commands.getCommands()
		if (commands.indexOf('eslint.executeAutofix') >= 0) {
			await vscode.commands.executeCommand('eslint.executeAutofix')
		}
	}

	static parse(code: string) {
		try {
			return ts.createSourceFile('nada', code, ts.ScriptTarget.ESNext, true)

		} catch (ex) {
			console.error(ex)
			return null
		}
	}
}

export class FileItem implements Item {
	private language: JavaScript
	readonly id: string
	readonly label: string
	readonly description: string
	readonly fileInfo: FileInfo
	sortablePath: string
	sortableName: string

	constructor(filePath: string, rootPath: string, language: JavaScript) {
		this.fileInfo = new FileInfo(filePath)
		this.id = this.fileInfo.fullPath
		this.language = language

		// Set containing directory of the given file
		this.description = _.trim(fp.dirname(this.fileInfo.fullPath.substring(rootPath.length)), fp.sep).replace(/\\/g, '/')

		if (this.language.getLanguageOptions().indexFile && this.checkIfIndexPath(this.fileInfo.fileNameWithExtension)) {
			this.label = this.fileInfo.directoryName
			this.description = _.trim(this.fileInfo.fullPath.substring(rootPath.length), fp.sep).replace(/\\/g, '/')
		} else if (this.language.getLanguageOptions().fileExtension === false && SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			this.label = this.fileInfo.fileNameWithoutExtension
		} else {
			this.label = this.fileInfo.fileNameWithExtension
		}

		// Set sorting rank according to the file name
		if (this.checkIfIndexPath(this.fileInfo.fileNameWithExtension)) {
			// Make index file appear on the top of its directory
			this.sortableName = '!'
		} else {
			this.sortableName = this.fileInfo.fileNameWithExtension.toLowerCase()
		}
	}

	getNameAndRelativePath(workingDocument: vscode.TextDocument) {
		const workingDirectory = new FileInfo(workingDocument.fileName).directoryPath
		const options = this.language.getLanguageOptions()
		let name = getVariableName(this.fileInfo.fileNameWithoutExtension, options)
		let path = this.fileInfo.getRelativePath(workingDirectory)

		if (options.indexFile && this.checkIfIndexPath(this.fileInfo.fileNameWithExtension)) {
			// Set the imported variable name to the directory name
			name = getVariableName(this.fileInfo.directoryName, options)

			// Remove "/index.js" from the imported path
			path = fp.dirname(path)

		} else if (options.fileExtension === false && SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			// Remove file extension from the imported path only if it matches the working document
			path = path.replace(new RegExp('\\.' + _.escapeRegExp(this.fileInfo.fileExtensionWithoutLeadingDot) + '$'), '')
		}

		return { name, path }
	}

	async addImport(editor: vscode.TextEditor) {
		const options = this.language.getLanguageOptions()
		const document = editor.document

		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)

		let beforeFirstImport = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			beforeFirstImport = document.positionAt(existingImports[0].node.getStart())
		}

		if (SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const pattern = await this.getImportPatternForJavaScript(document, existingImports)
			if (!pattern) {
				return null
			}

			const { name, path, kind } = pattern

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				// Try merging the given named import with the existing imports
				if (options.grouping && ts.isImportDeclaration(duplicateImport.node) && duplicateImport.node.importClause) {
					// There are 9 cases as a product of 3 by 3 cases:
					// 1) `import default from "path"`
					// 2) `import * as namespace from "path"`
					// 3) `import { named } from "path"`

					if (kind === 'namespace') {
						if (duplicateImport.node.importClause.name) {
							// Try merging `* as namespace` with `default`
							const position = document.positionAt(duplicateImport.node.importClause.name.getEnd())
							await editor.edit(worker => worker.insert(position, ', * as ' + name))
							await JavaScript.fixESLint()
							return null

						} else {
							// Try merging `* as namespace` with `* as namespace`
							// Try merging `* as namespace` with `{ named }`
							vscode.window.showInformationMessage(`The module "${name}" has been already imported.`)
							focusAt(duplicateImport.node.importClause.namedBindings, document)
							return null
						}

					} else if (kind === 'named') {
						if (duplicateImport.node.importClause.name) {
							// Try merging `{ named }` with `default`
							const position = document.positionAt(duplicateImport.node.importClause.name.getEnd())
							await editor.edit(worker => worker.insert(position, ', { ' + name + ' }'))
							await JavaScript.fixESLint()
							return null

						} else if (ts.isNamespaceImport(duplicateImport.node.importClause.namedBindings)) {
							// Try merging `{ named }` with `* as namespace`
							const namespaceImport = duplicateImport.node.importClause.namedBindings
							vscode.window.showInformationMessage(`The module "${path}" has been already imported as "${namespaceImport.name.text}".`)
							focusAt(namespaceImport, document)
							return null

						} else if (ts.isNamedImports(duplicateImport.node.importClause.namedBindings)) {
							// Try merging `{ named }` with `{ named }`
							if (duplicateImport.node.importClause.namedBindings.elements.some(node => node.name.text === name)) {
								vscode.window.showInformationMessage(`The module "${name}" has been already imported.`)
								focusAt(duplicateImport.node, document)
								return null

							} else {
								if (duplicateImport.node.importClause.namedBindings.elements.length > 0) {
									const position = document.positionAt(_.last(duplicateImport.node.importClause.namedBindings.elements).getEnd())
									await editor.edit(worker => worker.insert(position, ', ' + name))
									await JavaScript.fixESLint()
									return null

								} else {
									const position = document.positionAt(duplicateImport.node.importClause.namedBindings.getEnd() - 1)
									await editor.edit(worker => worker.insert(position, name))
									await JavaScript.fixESLint()
									return null
								}
							}
						}

					} else if (kind === 'default') { // In case of `import default from "path"`
						if (duplicateImport.node.importClause.name) {
							// Try merging `default` with `default`
							vscode.window.showInformationMessage(`The module "${name}" has been already imported.`)
							focusAt(duplicateImport.node, document)
							return null

						} else {
							// Try merging `default` with `* as namespace`
							// Try merging `default` with `{ named }`
							const position = document.positionAt(duplicateImport.node.importClause.namedBindings.getStart())
							await editor.edit(worker => worker.insert(position, name + ', '))
							await JavaScript.fixESLint()
							return null
						}

					} else {
						// In case of an invalid state
						return null
					}

				} else {
					vscode.window.showInformationMessage(`The module "${name}" has been already imported.`)
					focusAt(duplicateImport.node, document)
					return null
				}
			}

			let clause = name
			if (kind === 'namespace') {
				clause = '* as ' + name
			} else if (kind === 'named') {
				clause = '{ ' + name + ' }'
			}

			const snippet = await getImportSnippet(clause, path, options.syntax === 'import', options, document)
			await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
			await JavaScript.fixESLint()
			return null

		} else if (/^(css|less|sass|scss|styl)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const { path } = this.getNameAndRelativePath(document)

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				vscode.window.showInformationMessage(`The module "${this.label}" has been already imported.`)
				focusAt(duplicateImport.node, document)
				return null
			}

			const snippet = await getImportSnippet(null, path, options.syntax === 'import', options, document)
			await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
			await JavaScript.fixESLint()
			return null

		} else { // In case of other file types
			const { path } = this.getNameAndRelativePath(document)
			const snippet = await getImportSnippet(null, path, false, options, document)
			await editor.edit(worker => worker.insert(vscode.window.activeTextEditor.selection.active, snippet))
			await JavaScript.fixESLint()
			return null
		}
	}

	private checkIfIndexPath(fileNameWithExtension: string) {
		const parts = fileNameWithExtension.split('.')
		return parts.length === 2 && parts[0] === 'index' && SUPPORTED_EXTENSION.test(parts[1])
	}

	private getIndexPath() {
		return getFilePathWithExtension([this.fileInfo.directoryPath, 'index'], this.fileInfo.fileExtensionWithoutLeadingDot)
	}

	private hasIndexFile() {
		return fs.existsSync(this.getIndexPath())
	}

	private async getImportPatternForJavaScript(document: vscode.TextDocument, existingImports: Array<ImportStatementForReadOnly>): Promise<{ name: string, path: string, kind: 'named' | 'namespace' | 'default' }> {
		const options = this.language.getLanguageOptions()
		const { name, path } = this.getNameAndRelativePath(document)

		if (options.syntax !== 'import') {
			return {
				name,
				path,
				kind: 'default',
			}
		}

		// Try writing import through the index file
		if (this.hasIndexFile()) {
			let availableNames: Array<string> = []

			const exportedNamesFromIndexFile = getExportedIdentifiers(this.getIndexPath())
			if (this.fileInfo.fileNameWithoutExtension === 'index') {
				availableNames = Array.from(exportedNamesFromIndexFile.keys())

			} else {
				for (const [name, pathList] of exportedNamesFromIndexFile) {
					if (pathList.indexOf(this.fileInfo.fullPath) >= 0) {
						availableNames.push(name)
					}
				}
			}

			const workingDirectory = new FileInfo(document.fileName).directoryPath
			let indexFileRelativePath = new FileInfo(this.getIndexPath()).getRelativePath(workingDirectory)
			if (options.indexFile === false) {
				indexFileRelativePath = fp.dirname(indexFileRelativePath)

			} else if (options.fileExtension === false) {
				indexFileRelativePath = indexFileRelativePath.replace(new RegExp(_.escapeRegExp(fp.extname(indexFileRelativePath)) + '$'), '')
			}

			const duplicateImportForIndexFile = getDuplicateImport(existingImports, indexFileRelativePath)
			const duplicateImportHasImportedEverything = (
				duplicateImportForIndexFile &&
				ts.isImportDeclaration(duplicateImportForIndexFile.node) &&
				duplicateImportForIndexFile.node.importClause &&
				ts.isNamespaceImport(duplicateImportForIndexFile.node.importClause.namedBindings)
			)

			// Stop processing if there is `import * as name from "path"`
			if (availableNames.length > 0 && duplicateImportHasImportedEverything) {
				vscode.window.showInformationMessage(`The module "${name}" has been already imported from "${indexFileRelativePath}".`)
				focusAt(duplicateImportForIndexFile.node, document)
				return null
			}

			if (availableNames.length > 0) {
				const selectedName = await vscode.window.showQuickPick(_.sortBy(
					['*', ...availableNames],
					name => name === 'default' ? '^' : name
				))

				if (!selectedName) {
					return null
				}

				if (selectedName === '*') {
					return {
						name: name,
						path: indexFileRelativePath,
						kind: 'namespace',
					}

				} else if (selectedName === 'default') {
					return {
						name,
						path: indexFileRelativePath,
						kind: 'default',
					}

				} else {
					return {
						name: selectedName,
						path: indexFileRelativePath,
						kind: 'named',
					}
				}
			}
		}

		const exportedVariables = getExportedIdentifiers(this.fileInfo.fullPath)
		if (exportedVariables.size === 0) {
			return {
				name,
				path,
				kind: 'namespace',
			}

		} else if (exportedVariables.size === 1 && exportedVariables[0] === 'default') {
			return {
				name,
				path,
				kind: 'default',
			}
		}

		const selectedName = await vscode.window.showQuickPick(_.sortBy(
			['*', ...exportedVariables.keys()],
			name => name === 'default' ? '^' : name
		))

		if (!selectedName) {
			return null
		}

		if (selectedName === '*') {
			return {
				name,
				path,
				kind: 'namespace',
			}

		} else if (selectedName === 'default') {
			return {
				name,
				path,
				kind: 'default',
			}

		} else {
			return {
				name: selectedName,
				path,
				kind: 'named',
			}
		}
	}
}

class NodeItem implements Item {
	private language: JavaScript
	readonly id: string
	readonly label: string
	readonly description: string
	readonly name: string
	readonly path: string

	constructor(name: string, version: string, language: JavaScript) {
		this.id = 'node://' + name
		this.label = name
		this.description = version ? 'v' + version : ''
		this.name = getVariableName(name, language.getLanguageOptions())
		this.path = name
		this.language = language
	}

	async addImport(editor: vscode.TextEditor) {
		const options = this.language.getLanguageOptions()
		const document = editor.document

		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)
		const duplicateImport = existingImports.find(item => item.path === this.path)
		if (duplicateImport) {
			vscode.window.showInformationMessage(`The module "${this.path}" has been already imported.`)
			focusAt(duplicateImport.node, document)
			return null
		}

		let beforeFirstImport = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			beforeFirstImport = document.positionAt(existingImports[0].node.getStart())
		}

		const clause = this.language.checkIfImportDefaultIsPreferredOverNamespace()
			? this.name
			: `* as ${this.name}`

		const snippet = await getImportSnippet(clause, this.path, options.syntax === 'import', options, document)
		await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
		await JavaScript.fixESLint()
	}
}

function tryGetPathInRequire(node: ts.Node) {
	if (node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1) {
		const firstArgument = node.arguments[0]
		if (ts.isStringLiteral(firstArgument)) {
			return firstArgument.text
		}
	}
}

interface ImportStatementForReadOnly {
	node: ts.Node,
	path: string,
}

function getExistingImports(codeTree: ts.SourceFile) {
	const imports: ImportStatementForReadOnly[] = []

	codeTree.forEachChild(node => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			// For `import '...'`
			//     `import name from '...'`
			//     `import { name } from '...'`
			imports.push({ node, path: _.trimEnd(node.moduleSpecifier.text, '/') })

		} else if (ts.isVariableStatement(node)) {
			// For `var name = require('...')`
			//     `var { name } = require('...')`
			node.declarationList.declarations.forEach(node => {
				if (ts.isVariableDeclaration(node) && node.initializer && tryGetPathInRequire(node.initializer)) {
					imports.push({ node, path: tryGetPathInRequire(node.initializer) })
				}
			})

		} else if (ts.isExpressionStatement(node) && tryGetPathInRequire(node.expression)) {
			// For `require('...')`
			imports.push({ node, path: tryGetPathInRequire(node.expression) })
		}
	})

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

	} else if (options.variableNamingConvention === 'PascalCase') {
		return _.words(name).map(_.upperFirst).join('')

	} else if (options.variableNamingConvention === 'snake_case') {
		return _.snakeCase(name)

	} else if (options.variableNamingConvention === 'lowercase') {
		return _.words(name).join('').toLowerCase()

	} else {
		return name.match(/[a-z_$1-9]/gi).join('')
	}
}

async function matchNearbyFiles<T>(document: vscode.TextDocument, matcher: (filePath: string) => Promise<T>): Promise<T> {
	const workspaceDirectory = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath
	const workingDirectory = _.trim(document.uri.fsPath.substring(workspaceDirectory.length), fp.sep)
	const workingDirectoryParts = workingDirectory.split(fp.sep)
	do {
		workingDirectoryParts.pop() // Note that the first `pop()` is the file name itself

		const files = await vscode.workspace.findFiles(fp.join(...workingDirectoryParts, '*' + fp.extname(document.uri.fsPath)), null, 10)
		for (const file of files) {
			const result = await matcher(file.fsPath)
			if (result !== null && result !== undefined) {
				return result
			}
		}
	} while (workingDirectoryParts.length > 0)
}

async function getQuoteCharacter(documentOrFilePath: vscode.TextDocument | string): Promise<string> {
	const codeTree = JavaScript.parse(typeof documentOrFilePath === 'string' ? fs.readFileSync(documentOrFilePath, 'utf-8') : documentOrFilePath.getText())
	const chars = findNodesRecursively<ts.StringLiteral>(codeTree, node => ts.isStringLiteral(node)).map(node => node.getText().trim().charAt(0))
	if (chars.length > 0) {
		const singleQuoteCount = chars.filter(char => char === "'").length
		const doubleQuoteCount = chars.filter(char => char === '"').length
		if (singleQuoteCount > doubleQuoteCount) {
			return "'"
		} else if (doubleQuoteCount > singleQuoteCount) {
			return '"'
		} else {
			return chars[0]
		}
	}

	if (typeof documentOrFilePath === 'string') {
		return null
	}

	return matchNearbyFiles(documentOrFilePath, getQuoteCharacter)
}

async function hasSemiColon(documentOrFilePath: vscode.TextDocument | string): Promise<boolean> {
	const codeTree = JavaScript.parse(typeof documentOrFilePath === 'string' ? fs.readFileSync(documentOrFilePath, 'utf-8') : documentOrFilePath.getText())
	const statements = _.chain([codeTree, ...findNodesRecursively<ts.Block>(codeTree, node => ts.isBlock(node))])
		.map(block => Array.from(block.statements))
		.flatten()
		.uniq()
		.value()
	if (statements.length > 0) {
		return statements.some(node => node.getText().trim().endsWith(';'))
	}

	if (typeof documentOrFilePath === 'string') {
		return null
	}

	return matchNearbyFiles(documentOrFilePath, hasSemiColon)
}

async function getImportSnippet(clause: string, path: string, useImport: boolean, options: LanguageOptions, document: vscode.TextDocument) {
	let quote = "'"
	if (options.quoteCharacter === 'double') {
		quote = '"'
	} else if (options.quoteCharacter === 'auto') {
		quote = await getQuoteCharacter(document) || quote
	}

	const statementEnding = (options.semiColons === 'always' || options.semiColons === 'auto' && await hasSemiColon(document)) ? ';' : ''

	const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'

	if (useImport) {
		if (clause) {
			return `import ${clause} from ${quote}${path}${quote}` + statementEnding + lineEnding
		} else {
			return `import ${quote}${path}${quote}` + statementEnding + lineEnding
		}

	} else {
		if (clause) {
			return `const ${clause} = require(${quote}${path}${quote})` + statementEnding + lineEnding
		} else {
			return `require(${quote}${path}${quote})`
		}
	}
}

function getExportedIdentifiers(filePath: string) {
	const fileDirectory = fp.dirname(filePath)
	const fileExtension = _.trimStart(fp.extname(filePath), '.')

	const importedNames = new Map<string, Array<string>>()
	const exportedNames = new Map<string, Array<string>>()

	try {
		const codeTree = JavaScript.parse(fs.readFileSync(filePath, 'utf-8'))
		codeTree.forEachChild(node => {
			if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				const path = getFilePathWithExtension([fileDirectory, node.moduleSpecifier.text], fileExtension)

				if (node.importClause.name) {
					// import named from "path"
					importedNames.set(node.importClause.name.text, [path])
				}

				if (node.importClause.namedBindings) {
					if (ts.isNamedImports(node.importClause.namedBindings)) {
						// import { named } from "path"
						for (const stub of node.importClause.namedBindings.elements) {
							const name = stub.name.text
							const pathList: Array<string> = [path]
							const transitVariables = getExportedIdentifiers(path)
							if (transitVariables.has(name)) {
								pathList.push(...transitVariables.get(name))
							}
							importedNames.set(name, pathList)
						}

					} else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
						// import * as namespace from "path"
						importedNames.set(node.importClause.namedBindings.name.text, [path])
					}
				}

			} else if (ts.isExportDeclaration(node)) {
				const path = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
					? getFilePathWithExtension([fileDirectory, node.moduleSpecifier.text], fileExtension)
					: null
				if (node.exportClause) {
					node.exportClause.elements.forEach(stub => {
						const name = stub.name.text
						if (path) {
							// export { named as exported } from "path"
							exportedNames.set(name, [path])

						} else {
							// export { named as exported }
							const pathList = [filePath]
							if (importedNames.has(name)) {
								pathList.push(...importedNames.get(name))
							}
							exportedNames.set(name, pathList)
						}
					})

				} else {
					// export * from "path"
					const transitVariables = getExportedIdentifiers(path)
					transitVariables.forEach((pathList, name) => {
						exportedNames.set(name, pathList)
					})
				}

			} else if (ts.isExportAssignment(node)) {
				// export default named
				exportedNames.set('default', [filePath])

			} else if (
				(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
				node.modifiers && node.modifiers.length > 0 && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword
			) {
				if (node.modifiers.length > 1 && node.modifiers[1].kind === ts.SyntaxKind.DefaultKeyword) {
					// export default function () {}
					// export default function named () {}
					exportedNames.set('default', [filePath])

				} else if (node.name) {
					// export function named () {}
					// export class named {}
					// export interface named {}
					// export type named = ...
					exportedNames.set(node.name.text, [filePath])
				}

			} else if (
				ts.isVariableStatement(node) &&
				node.modifiers && node.modifiers.length > 0 && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword
			) {
				// export const ...
				node.declarationList.declarations.forEach(stub => {
					if (ts.isIdentifier(stub.name)) {
						exportedNames.set(stub.name.text, [filePath])
					}
				})

			} else if (
				ts.isExpressionStatement(node) &&
				ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isPropertyAccessExpression(node.expression.left) &&
				ts.isIdentifier(node.expression.left.expression) && node.expression.left.expression.text === 'module' && node.expression.left.name.text === 'exports' &&
				ts.isObjectLiteralExpression(node.expression.right)
			) {
				// module.exports = { key: value }
				exportedNames.set('default', [filePath])

			} else if (
				ts.isExpressionStatement(node) &&
				ts.isBinaryExpression(node.expression) &&
				ts.isPropertyAccessExpression(node.expression.left) &&
				ts.isPropertyAccessExpression(node.expression.left.expression) &&
				ts.isIdentifier(node.expression.left.expression.expression) &&
				node.expression.left.expression.expression.text === 'module' &&
				ts.isIdentifier(node.expression.left.expression.name) &&
				node.expression.left.expression.name.text === 'exports'
			) {
				// module.exports['...'] = ...
				exportedNames.set(node.expression.left.name.text, [filePath])
			}
		})

	} catch (ex) {
		console.error(ex)
	}
	return exportedNames
}

function getFilePathWithExtension(pathList: Array<string>, preferredExtension: string) {
	const filePath = fp.resolve(...pathList)

	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile) {
		return filePath
	}

	for (const extension of _.uniq([preferredExtension.toLowerCase(), 'tsx', 'ts', 'jsx', 'js'])) {
		if (fs.existsSync(filePath + '.' + extension)) {
			return filePath + '.' + extension
		}
	}

	return filePath + '.' + preferredExtension
}

function getDuplicateImport(existingImports: Array<ImportStatementForReadOnly>, path: string) {
	return existingImports.find(stub => stub.path === path)
}

function findNodesRecursively<T extends ts.Node>(node: ts.Node, condition: (node: ts.Node) => boolean, results: Array<T> = [], visited = new Set<ts.Node>()) {
	if (node === null || node === undefined) {
		return results
	}

	if (visited.has(node)) {
		return results

	} else {
		visited.add(node)
	}

	if (condition(node)) {
		results.push(node as T)
		return results

	} else {
		node.forEachChild(stub => {
			findNodesRecursively(stub, condition, results, visited)
		})
	}

	return results
}

function focusAt(node: { getStart: () => number, getEnd: () => number }, document: vscode.TextDocument) {
	vscode.window.activeTextEditor.revealRange(
		new vscode.Range(
			document.positionAt(node.getStart()),
			document.positionAt(node.getEnd())
		),
		vscode.TextEditorRevealType.InCenterIfOutsideViewport
	)
}

function getLocalModuleVersion(name: string, rootPath: string) {
	try {
		const packageJson = JSON.parse(fs.readFileSync(fp.join(rootPath, 'node_modules', name, 'package.json'), 'utf-8'))
		if (packageJson.version) {
			return packageJson.version as string
		}
	} catch (ex) {
		// Do nothing
	}
	return null
}

function getNodeJsAPIs(rootPath: string) {
	try {
		const codeTree = JavaScript.parse(fs.readFileSync(fp.join(rootPath, 'node_modules', '@types/node', 'index.d.ts'), 'utf-8'))
		return _.compact(codeTree.statements.map(node => {
			if (
				ts.isModuleDeclaration(node) &&
				node.modifiers && node.modifiers.length > 0 &&
				node.modifiers[0].kind === ts.SyntaxKind.DeclareKeyword &&
				(ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))
			) {
				// declare module "name" { ... }
				return node.name.text
			}
		}))

	} catch (ex) {
		console.error(ex)
	}
	return []
}
