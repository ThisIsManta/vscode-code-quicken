import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import * as ts from 'typescript'

import { RootConfigurations, Language, Item, getSortablePath, findFilesRoughly } from './global';
import FileInfo from './FileInfo'

export interface LanguageOptions {
	syntax: 'import' | 'require' | 'auto'
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

	protected acceptedLanguage = /^javascript(react)?$/

	constructor(baseConfig: RootConfigurations) {
		this.baseConfig = baseConfig
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
				this.label = fullPath.substring(rootPath.length)
			}
		}

		const codeTree = JavaScript.parse(document)

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
	}

	protected async createFileFilter() {
		return (link: vscode.Uri) => true
	}

	static async fixESLint() {
		const commands = await vscode.commands.getCommands(true)
		if (commands.indexOf('eslint.executeAutofix') >= 0) {
			await vscode.commands.executeCommand('eslint.executeAutofix')
		}
	}

	static parse(documentOrFilePath: vscode.TextDocument | string) {
		try {
			const filePath = typeof documentOrFilePath === 'string' ? documentOrFilePath : documentOrFilePath.fileName
			const codeText = typeof documentOrFilePath === 'string' ? fs.readFileSync(filePath, 'utf-8') : documentOrFilePath.getText()
			return ts.createSourceFile(filePath, codeText, ts.ScriptTarget.ESNext, true)

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

		this.label = this.fileInfo.fileNameWithExtension
		this.description = _.trim(fp.dirname(this.fileInfo.fullPath.substring(rootPath.length)), fp.sep)

		if (this.language.getLanguageOptions().indexFile === false && checkIfIndexFile(this.fileInfo.fileNameWithExtension)) {
			this.label = this.fileInfo.directoryName
			this.description = _.trim(this.fileInfo.fullPath.substring(rootPath.length), fp.sep)
		} else if (this.language.getLanguageOptions().fileExtension === false && SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			this.label = this.fileInfo.fileNameWithoutExtension
		}

		// Set sorting rank according to the file name
		if (checkIfIndexFile(this.fileInfo.fileNameWithExtension)) {
			// Make index file appear on the top of its directory
			this.sortableName = '!'
		} else {
			this.sortableName = this.fileInfo.fileNameWithExtension.toLowerCase()
		}
	}

	getNameAndRelativePath(document: vscode.TextDocument) {
		const workingDirectory = new FileInfo(document.fileName).directoryPath
		const options = this.language.getLanguageOptions()
		let name = getVariableName(this.fileInfo.fileNameWithoutExtension, options)
		let path = this.fileInfo.getRelativePath(workingDirectory)

		if (checkIfIndexFile(this.fileInfo.fileNameWithExtension)) {
			// Set the identifier as the directory name
			name = getVariableName(this.fileInfo.directoryName, options)
		}

		if (options.indexFile === false && checkIfIndexFile(this.fileInfo.fileNameWithExtension)) {
			// Remove "/index.js" from the path
			path = fp.dirname(path)

		} else if (options.fileExtension === false && SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			// Remove file extension from the path only if it matches the working document
			path = path.replace(new RegExp('\\.' + _.escapeRegExp(this.fileInfo.fileExtensionWithoutLeadingDot) + '$'), '')
		}

		return { name, path }
	}

	async addImport(editor: vscode.TextEditor) {
		const options = this.language.getLanguageOptions()
		const document = editor.document

		const codeTree = JavaScript.parse(document)

		const existingImports = getExistingImports(codeTree)

		let beforeFirstImport = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			beforeFirstImport = document.positionAt(existingImports[0].node.getStart())
		}

		if (SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const pattern = await this.getImportPatternForJavaScript(existingImports, document)
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
						if (duplicateImport.node.importClause.namedBindings) {
							// Try merging `* as namespace` with `* as namespace`
							// Try merging `* as namespace` with `{ named }`
							vscode.window.showErrorMessage(`The module "${name}" has been already imported.`, { modal: true })
							focusAt(duplicateImport.node.importClause.namedBindings, document)
							return null

						} else {
							// Try merging `* as namespace` with `default`
							const position = document.positionAt(duplicateImport.node.importClause.name.getEnd())
							await editor.edit(worker => worker.insert(position, ', * as ' + name))
							await JavaScript.fixESLint()
							return null
						}

					} else if (kind === 'named') {
						if (ts.isNamespaceImport(duplicateImport.node.importClause.namedBindings)) {
							// Try merging `{ named }` with `* as namespace`
							const namespaceImport = duplicateImport.node.importClause.namedBindings
							vscode.window.showErrorMessage(`The module "${path}" has been already imported as "${namespaceImport.name.text}".`, { modal: true })
							focusAt(namespaceImport, document)
							return null

						} else if (duplicateImport.node.importClause.name) {
							// Try merging `{ named }` with `default`
							const position = document.positionAt(duplicateImport.node.importClause.name.getEnd())
							await editor.edit(worker => worker.insert(position, ', { ' + name + ' }'))
							await JavaScript.fixESLint()
							return null


						} else if (ts.isNamedImports(duplicateImport.node.importClause.namedBindings)) {
							// Try merging `{ named }` with `{ named }`
							if (duplicateImport.node.importClause.namedBindings.elements.some(node => node.name.text === name)) {
								vscode.window.showErrorMessage(`The module "${name}" has been already imported.`, { modal: true })
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
							vscode.window.showErrorMessage(`The module "${name}" has been already imported.`, { modal: true })
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
					vscode.window.showErrorMessage(`The module "${name}" has been already imported.`, { modal: true })
					focusAt(duplicateImport.node, document)
					return null
				}
			}

			let importClause = name
			if (kind === 'namespace') {
				importClause = '* as ' + name
			} else if (kind === 'named') {
				importClause = '{ ' + name + ' }'
			}

			const snippet = await getImportOrRequireSnippet(name, importClause, path, options, codeTree, document)
			await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
			await JavaScript.fixESLint()
			return null

		} else if (/^(css|less|sass|scss|styl)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const { path } = this.getNameAndRelativePath(document)

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				vscode.window.showErrorMessage(`The module "${this.label}" has been already imported.`, { modal: true })
				focusAt(duplicateImport.node, document)
				return null
			}

			const snippet = await getImportOrRequireSnippet(null, null, path, options, codeTree, document)
			await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
			await JavaScript.fixESLint()
			return null

		} else { // In case of other file types
			const { path } = this.getNameAndRelativePath(document)
			const snippet = await getImportOrRequireSnippet(null, null, path, { ...options, syntax: 'require' }, codeTree, document)
			await editor.edit(worker => worker.insert(vscode.window.activeTextEditor.selection.active, snippet))
			await JavaScript.fixESLint()
			return null
		}
	}

	private async getImportPatternForJavaScript(existingImports: Array<ImportStatementForReadOnly>, document: vscode.TextDocument): Promise<{ name: string, path: string, kind: 'named' | 'namespace' | 'default' }> {
		const options = this.language.getLanguageOptions()
		const workspaceDirectory = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath
		const { name, path } = this.getNameAndRelativePath(document)

		if (options.syntax === 'require') {
			return {
				name,
				path,
				kind: 'default',
			}
		}

		// Try writing import through the index file
		const indexFilePath = getFilePath([this.fileInfo.directoryPath, 'index'], this.fileInfo.fileExtensionWithoutLeadingDot)
		if (indexFilePath) {
			const pickers: Array<vscode.QuickPickItem> = []

			const exportedIdentifiersFromIndexFile = getExportedIdentifiers(indexFilePath)
			for (const [name, { text, pathList }] of exportedIdentifiersFromIndexFile) {
				if (pathList.indexOf(this.fileInfo.fullPath) === -1) {
					continue
				}

				const sourcePath = _.last(pathList)
				pickers.push({
					label: name,
					description: sourcePath === this.fileInfo.fullPath ? null : _.trim(sourcePath.substring(workspaceDirectory.length), fp.sep),
					detail: _.truncate(text, { length: 120, omission: '...' }),
				})
			}

			const workingDirectory = new FileInfo(document.fileName).directoryPath
			let indexFileRelativePath = new FileInfo(indexFilePath).getRelativePath(workingDirectory)
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
			if (pickers.length > 0 && duplicateImportHasImportedEverything) {
				vscode.window.showErrorMessage(`The module "${name}" has been already imported from "${indexFileRelativePath}".`, { modal: true })
				focusAt(duplicateImportForIndexFile.node, document)
				return null
			}

			if (pickers.length > 0) {
				const selectedPicker = await vscode.window.showQuickPick(_.sortBy(
					[{ label: '*' }, ...pickers],
					item => item.label === 'default' ? '+' : item.label.toLowerCase() // Note that '+' comes after '*'
				))

				if (!selectedPicker) {
					return null
				}

				if (selectedPicker.label === '*') {
					return {
						name: name,
						path: indexFileRelativePath,
						kind: 'namespace',
					}

				} else if (selectedPicker.label === 'default') {
					return {
						name,
						path: indexFileRelativePath,
						kind: 'default',
					}

				} else {
					return {
						name: selectedPicker.label,
						path: indexFileRelativePath,
						kind: 'named',
					}
				}
			}
		}

		const exportedIdentifiers = getExportedIdentifiers(this.fileInfo.fullPath)
		if (exportedIdentifiers.size === 0) {
			return {
				name,
				path,
				kind: 'namespace',
			}

		} else if (exportedIdentifiers.size === 1 && exportedIdentifiers.has('default')) {
			return {
				name,
				path,
				kind: 'default',
			}
		}

		let pickers: Array<vscode.QuickPickItem> = [{ label: '*' }]
		for (const [name, { text, pathList }] of exportedIdentifiers) {
			const sourcePath = _.last(pathList)
			pickers.push({
				label: name,
				description: sourcePath === this.fileInfo.fullPath ? null : _.trim(sourcePath.substring(workspaceDirectory.length), fp.sep),
				detail: _.truncate(text, { length: 120, omission: '...' }),
			})
		}
		pickers = _.sortBy(
			pickers,
			item => item.label === 'default' ? '+' : item.label.toLowerCase() // Note that '+' comes after '*'
		)

		const selectedPicker = await vscode.window.showQuickPick(pickers)
		if (!selectedPicker) {
			return null
		}

		if (selectedPicker.label === '*') {
			return {
				name,
				path,
				kind: 'namespace',
			}

		} else if (selectedPicker.label === 'default') {
			return {
				name,
				path,
				kind: 'default',
			}

		} else {
			return {
				name: selectedPicker.label,
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

		const codeTree = JavaScript.parse(document)

		const existingImports = getExistingImports(codeTree)
		const duplicateImport = existingImports.find(item => item.path === this.path)
		if (duplicateImport) {
			vscode.window.showErrorMessage(`The module "${this.path}" has been already imported.`, { modal: true })
			focusAt(duplicateImport.node, document)
			return null
		}

		let beforeFirstImport = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			beforeFirstImport = document.positionAt(existingImports[0].node.getStart())
		}

		const importClause = this.language.checkIfImportDefaultIsPreferredOverNamespace()
			? this.name
			: `* as ${this.name}`

		const snippet = await getImportOrRequireSnippet(this.name, importClause, this.path, options, codeTree, document)
		await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
		await JavaScript.fixESLint()
	}
}

function checkIfIndexFile(fileNameWithExtension: string) {
	const parts = fileNameWithExtension.split('.')
	return parts.length === 2 && parts[0] === 'index' && SUPPORTED_EXTENSION.test(parts[1])
}

function getRequirePath(node: ts.Node) {
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
				if (ts.isVariableDeclaration(node) && node.initializer && getRequirePath(node.initializer)) {
					imports.push({ node, path: getRequirePath(node.initializer) })
				}
			})

		} else if (ts.isExpressionStatement(node) && getRequirePath(node.expression)) {
			// For `require('...')`
			imports.push({ node, path: getRequirePath(node.expression) })
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

async function matchNearbyFiles<T>(filePath: string, matcher: (codeTree: ts.SourceFile, stopPropagation?: boolean) => Promise<T>): Promise<T> {
	const workingDocumentLink = vscode.Uri.file(filePath)
	const workspaceDirectory = vscode.workspace.getWorkspaceFolder(workingDocumentLink).uri.fsPath
	const workingDirectory = _.trim(workingDocumentLink.fsPath.substring(workspaceDirectory.length), fp.sep)
	const workingDirectoryParts = workingDirectory.split(fp.sep)
	do {
		workingDirectoryParts.pop() // Note that the first `pop()` is the file name itself

		const fileLinks = await vscode.workspace.findFiles(fp.join(...workingDirectoryParts, '**', '*' + fp.extname(workingDocumentLink.fsPath)), null, 10)
		for (const link of fileLinks) {
			if (link.fsPath === workingDocumentLink.fsPath) {
				continue
			}

			const codeTree = JavaScript.parse(link.fsPath)
			if (!codeTree) {
				continue
			}

			const result = await matcher(codeTree, true)
			if (result !== null && result !== undefined) {
				return result
			}
		}
	} while (workingDirectoryParts.length > 0)
}

async function getQuoteCharacter(codeTree: ts.SourceFile, stopPropagation?: boolean): Promise<string> {
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

	if (stopPropagation) {
		return null
	}

	return matchNearbyFiles(codeTree.fileName, getQuoteCharacter)
}

async function hasSemiColon(codeTree: ts.SourceFile, stopPropagation?: boolean): Promise<boolean> {
	const statements = _.chain([codeTree, ...findNodesRecursively<ts.Block>(codeTree, node => ts.isBlock(node))])
		.map(block => Array.from(block.statements))
		.flatten()
		.uniq()
		.value()
	if (statements.length > 0) {
		return statements.some(node => node.getText().trim().endsWith(';'))
	}

	if (stopPropagation) {
		return null
	}

	return matchNearbyFiles(codeTree.fileName, hasSemiColon)
}

async function hasImportSyntax(codeTree: ts.SourceFile, stopPropagation?: boolean): Promise<boolean> {
	if (codeTree.statements.some(node => ts.isImportDeclaration(node))) {
		return true
	}

	if (findNodesRecursively(codeTree, node => !!getRequirePath(node)).length > 0) {
		return false
	}

	if (stopPropagation) {
		return null
	}

	return matchNearbyFiles(codeTree.fileName, hasImportSyntax)
}

async function getImportOrRequireSnippet(identifier: string, importClause: string, path: string, options: LanguageOptions, codeTree: ts.SourceFile, document: vscode.TextDocument) {
	let quote = "'"
	if (options.quoteCharacter === 'double') {
		quote = '"'
	} else if (options.quoteCharacter === 'auto') {
		quote = await getQuoteCharacter(codeTree) || quote
	}

	const statementEnding = (options.semiColons === 'always' || options.semiColons === 'auto' && await hasSemiColon(codeTree)) ? ';' : ''

	const lineEnding = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'

	if (options.syntax === 'import' || options.syntax === 'auto' && await hasImportSyntax(codeTree)) {
		if (importClause) {
			return `import ${importClause} from ${quote}${path}${quote}` + statementEnding + lineEnding
		} else {
			return `import ${quote}${path}${quote}` + statementEnding + lineEnding
		}

	} else {
		if (identifier) {
			return `const ${identifier} = require(${quote}${path}${quote})` + statementEnding + lineEnding
		} else {
			return `require(${quote}${path}${quote})`
		}
	}
}

interface IdentifierMap extends Map<string, { text: string, pathList: Array<string> }> { }

function getExportedIdentifiers(filePath: string, cachedFilePaths = new Map<string, IdentifierMap>(), processingFilePaths = new Set<string>()) {
	if (cachedFilePaths.has(filePath)) {
		return cachedFilePaths.get(filePath)
	}

	const fileDirectory = fp.dirname(filePath)
	const fileExtension = _.trimStart(fp.extname(filePath), '.')

	const importedNames: IdentifierMap = new Map()
	const exportedNames: IdentifierMap = new Map()

	// Prevent looping indefinitely because of a cyclic dependency
	if (processingFilePaths.has(filePath)) {
		return exportedNames
	} else {
		processingFilePaths.add(filePath)
	}

	try {
		const codeTree = JavaScript.parse(filePath)
		codeTree.forEachChild(node => {
			if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
				if (/^[\.\/]/.test(node.moduleSpecifier.text) === false) {
					return
				}

				const path = getFilePath([fileDirectory, node.moduleSpecifier.text], fileExtension)
				if (path === undefined) {
					return
				}

				const transitIdentifiers = getExportedIdentifiers(path, cachedFilePaths, processingFilePaths)

				if (node.importClause.name) {
					// import named from "path"
					if (transitIdentifiers.has('default')) {
						const { text, pathList } = transitIdentifiers.get('default')
						importedNames.set(node.importClause.name.text, { text, pathList: [path, ...pathList] })
					} else {
						importedNames.set(node.importClause.name.text, { text: null, pathList: [path] })
					}
				}

				if (node.importClause.namedBindings) {
					if (ts.isNamedImports(node.importClause.namedBindings)) {
						// import { named } from "path"
						for (const stub of node.importClause.namedBindings.elements) {
							const name = stub.name.text
							if (transitIdentifiers.has(name)) {
								const { text, pathList } = transitIdentifiers.get(name)
								importedNames.set(name, { text, pathList: [path, ...pathList] })
							}
						}

					} else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
						// import * as namespace from "path"
						// TODO: find the correct text by tracing `Namespace.Named`
						importedNames.set(node.importClause.namedBindings.name.text, { text: node.getText(), pathList: [path] })
					}
				}

			} else if (ts.isExportDeclaration(node)) {
				const path = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) &&
					getFilePath([fileDirectory, node.moduleSpecifier.text], fileExtension)

				if (node.exportClause) {
					node.exportClause.elements.forEach(stub => {
						const name = stub.name.text
						if (path) {
							const transitIdentifiers = getExportedIdentifiers(path, cachedFilePaths, processingFilePaths)
							if (stub.propertyName && transitIdentifiers.has(stub.propertyName.text)) {
								// export { named as exported } from "path"
								const { text, pathList } = transitIdentifiers.get(stub.propertyName.text)
								exportedNames.set(name, { text, pathList: [path, ...pathList] })

							} else if (transitIdentifiers.has(name)) {
								// export { named } from "path"
								const { text, pathList } = transitIdentifiers.get(name)
								exportedNames.set(name, { text, pathList: [path, ...pathList] })
							}

						} else {
							if (stub.propertyName && importedNames.has(stub.propertyName.text)) {
								// export { named as exported }
								const { text, pathList } = importedNames.get(stub.propertyName.text)
								exportedNames.set(name, { text, pathList: [filePath, ...pathList] })

							} else if (importedNames.has(name)) {
								// export { named }
								const { text, pathList } = importedNames.get(name)
								exportedNames.set(name, { text, pathList: [filePath, ...pathList] })
							}
						}
					})

				} else {
					// export * from "path"
					const transitIdentifiers = getExportedIdentifiers(path, cachedFilePaths, processingFilePaths)
					transitIdentifiers.forEach(({ text, pathList }, name) => {
						exportedNames.set(name, { text, pathList: [filePath, ...pathList] })
					})
				}

			} else if (ts.isExportAssignment(node)) {
				// export default named
				if (ts.isIdentifier(node.expression) && importedNames.has(node.expression.text)) {
					const { text, pathList } = importedNames.get(node.expression.text)
					exportedNames.set('default', { text, pathList: [filePath, ...pathList] })
				} else {
					exportedNames.set('default', { text: node.getText(), pathList: [filePath] })
				}

			} else if (
				(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
				node.modifiers && node.modifiers.length > 0 && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword
			) {
				if (node.modifiers.length > 1 && node.modifiers[1].kind === ts.SyntaxKind.DefaultKeyword) {
					// export default function () {}
					// export default function named () {}
					exportedNames.set('default', { text: node.getText(), pathList: [filePath] })

				} else if (node.name) {
					// export function named () {}
					// export class named {}
					// export interface named {}
					// export type named = ...
					exportedNames.set(node.name.text, { text: node.getText(), pathList: [filePath] })
				}

			} else if (
				ts.isVariableStatement(node) &&
				node.modifiers && node.modifiers.length > 0 && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword
			) {
				// export const named = ...
				node.declarationList.declarations.forEach(stub => {
					if (ts.isIdentifier(stub.name)) {
						exportedNames.set(stub.name.text, { text: node.getText(), pathList: [filePath] })
					}
				})

			} else if (
				ts.isExpressionStatement(node) &&
				ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isPropertyAccessExpression(node.expression.left) &&
				ts.isIdentifier(node.expression.left.expression) && node.expression.left.expression.text === 'module' && node.expression.left.name.text === 'exports' &&
				ts.isObjectLiteralExpression(node.expression.right)
			) {
				// module.exports = { ... }
				if (ts.isIdentifier(node.expression.right) && importedNames.has(node.expression.right.text)) {
					const { text, pathList } = importedNames.get(node.expression.right.text)
					exportedNames.set('default', { text, pathList: [filePath, ...pathList] })
				} else {
					exportedNames.set('default', { text: node.getText(), pathList: [filePath] })
				}

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
				// module.exports.named = ...
				if (ts.isIdentifier(node.expression.right) && importedNames.has(node.expression.right.text)) {
					const { text, pathList } = importedNames.get(node.expression.right.text)
					exportedNames.set(node.expression.left.name.text, { text, pathList: [filePath, ...pathList] })
				} else {
					exportedNames.set(node.expression.left.name.text, { text: node.getText(), pathList: [filePath] })
				}
			}
		})

	} catch (ex) {
		console.error(ex)
	}

	if (cachedFilePaths.has(filePath) === false) {
		cachedFilePaths.set(filePath, exportedNames)
	}

	processingFilePaths.delete(filePath)

	return exportedNames
}

function getFilePath(pathList: Array<string>, preferredExtension: string): string {
	const filePath = fp.resolve(...pathList)

	if (fs.existsSync(filePath)) {
		const fileStat = fs.lstatSync(filePath)
		if (fileStat.isFile()) {
			return filePath

		} else if (fileStat.isDirectory()) {
			return getFilePath([...pathList, 'index'], preferredExtension)
		}
	}

	const possibleExtensions = _.uniq([preferredExtension.toLowerCase(), 'tsx', 'ts', 'jsx', 'js'])
	for (const extension of possibleExtensions) {
		const fullPath = filePath + '.' + extension
		if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isFile()) {
			return fullPath
		}
	}
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
		const codeTree = JavaScript.parse(fp.join(rootPath, 'node_modules', '@types/node', 'index.d.ts'))
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
