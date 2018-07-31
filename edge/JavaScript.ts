import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import * as ts from 'typescript'

import { Configurations, Language, Item, getSortablePath, findFilesRoughly } from './global';
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
	private fileItemCache: Array<FileItem>
	private nodeItemCache: Array<NodeItem>

	protected acceptedLanguage = /^javascript(react)?$/

	public options: LanguageOptions

	constructor(config: Configurations) {
		this.options = config.javascript
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

		const fileFilterRule = _.toPairs(this.options.filteredFileList)
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

		if (this.language.options.indexFile === false && checkIfIndexFile(this.fileInfo.fileNameWithExtension)) {
			this.label = this.fileInfo.directoryName
			this.description = _.trim(this.fileInfo.fullPath.substring(rootPath.length), fp.sep)
		} else if (this.language.options.fileExtension === false && SUPPORTED_EXTENSION.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
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
		const options = this.language.options
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
		const options = this.language.options
		const document = editor.document

		const codeTree = JavaScript.parse(document)

		const existingImports = getExistingImports(codeTree)

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
							let givenName = name
							if (duplicateImport.node.importClause.name.text === name) {
								const conflictedIdentifierNode = duplicateImport.node.importClause.name
								const options = [
									{
										title: 'Rename The Default',
										action: async () => {
											// Do not `await` here because it does not work anyway
											vscode.commands.executeCommand('editor.action.rename', [document.uri, document.positionAt(conflictedIdentifierNode.getStart())])
											return name
										}
									},
									{
										title: 'Name The Namespace',
										action: async () => {
											return await vscode.window.showInputBox({
												ignoreFocusOut: true,
												value: name,
												validateInput: inputText => validJavaScriptIdentifier.test(inputText) ? null : 'Not a valid JavaScript identifier.',
											})
										}
									}
								]
								const selectedOption = await vscode.window.showWarningMessage(`The identifier "${name}" has been used.`, { modal: true }, ...options)
								if (!selectedOption) {
									return null
								}
								givenName = await selectedOption.action()
								if (!givenName) {
									return null
								}
							}

							const position = document.positionAt(duplicateImport.node.importClause.name.getEnd())
							await editor.edit(worker => worker.insert(position, ', * as ' + givenName))
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

						} else if (ts.isNamespaceImport(duplicateImport.node.importClause.namedBindings)) {
							// Try merging `default` with `* as namespace`
							let givenName = name
							if (duplicateImport.node.importClause.namedBindings.name.text === name) {
								// Cannot have a rename option here because of adding the identifier at the left side of the renaming position
								givenName = await await vscode.window.showInputBox({
									ignoreFocusOut: true,
									value: name,
									validateInput: inputText => validJavaScriptIdentifier.test(inputText) ? null : 'Not a valid JavaScript identifier.',
								})
								if (!givenName) {
									return null
								}
							}

							const position = document.positionAt(duplicateImport.node.importClause.namedBindings.getStart())
							await editor.edit(worker => worker.insert(position, givenName + ', '))
							await JavaScript.fixESLint()
							return null

						} else {
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
			await editor.edit(worker => worker.insert(getInsertionPosition(existingImports, path, document), snippet))
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
			await editor.edit(worker => worker.insert(getInsertionPosition(existingImports, path, document), snippet))
			await JavaScript.fixESLint()
			return null

		} else { // In case of other file types
			const { name, path } = this.getNameAndRelativePath(document)
			const identifierOnlyForJsonFile = this.fileInfo.fileExtensionWithoutLeadingDot === 'json' ? name : null
			const snippet = await getImportOrRequireSnippet(identifierOnlyForJsonFile, null, path, { ...options, syntax: 'require' }, codeTree, document)
			await editor.edit(worker => worker.insert(vscode.window.activeTextEditor.selection.active, snippet))
			await JavaScript.fixESLint()
			return null
		}
	}

	private async getImportPatternForJavaScript(existingImports: Array<ImportStatementForReadOnly>, document: vscode.TextDocument): Promise<{ name: string, path: string, kind: 'named' | 'namespace' | 'default' }> {
		const options = this.language.options
		const workingDirectory = fp.dirname(document.fileName)
		const { name, path } = this.getNameAndRelativePath(document)

		// Try writing import through the index file
		const indexFilePath = getFilePath([this.fileInfo.directoryPath, 'index'], this.fileInfo.fileExtensionWithoutLeadingDot)
		if (indexFilePath && indexFilePath.startsWith(workingDirectory) === false) {
			let pickers: Array<IdentifierItem> = []

			const exportedIdentifiersFromIndexFile = getExportedIdentifiers(indexFilePath)
			for (const [name, { text, pathList }] of exportedIdentifiersFromIndexFile) {
				if (pathList.indexOf(this.fileInfo.fullPath) === -1) {
					continue
				}

				pickers.push(new IdentifierItem(name, text, this.fileInfo.fullPath, pathList))
			}

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

			if (options.syntax === 'require') {
				return {
					name,
					path: indexFileRelativePath,
					kind: 'default',
				}
			}

			if (pickers.length === 1) {
				if (pickers[0].defaultExported) {
					return {
						name,
						path: indexFileRelativePath,
						kind: 'default',
					}

				} else {
					return {
						name: pickers[0].label,
						path: indexFileRelativePath,
						kind: 'named',
					}
				}
			}

			if (pickers.length > 0) {
				pickers = _.sortBy(pickers, picker => picker.sortingKey)
				const selectedPicker = await vscode.window.showQuickPick([{ label: '*' }, ...pickers])

				if (!selectedPicker) {
					return null
				}

				if (selectedPicker.label === '*') {
					return {
						name: name,
						path: indexFileRelativePath,
						kind: 'namespace',
					}

				} else if ((selectedPicker as IdentifierItem).defaultExported) {
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

		if (options.syntax === 'require') {
			return {
				name,
				path,
				kind: 'default',
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

		let pickers: Array<IdentifierItem> = []
		for (const [name, { text, pathList }] of exportedIdentifiers) {
			pickers.push(new IdentifierItem(name, text, this.fileInfo.fullPath, pathList))
		}
		pickers = _.sortBy(pickers, picker => picker.sortingKey)

		const selectedPicker = await vscode.window.showQuickPick([{ label: '*' }, ...pickers])
		if (!selectedPicker) {
			return null
		}

		if (selectedPicker.label === '*') {
			return {
				name,
				path,
				kind: 'namespace',
			}

		} else if ((selectedPicker as IdentifierItem).defaultExported) {
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

class IdentifierItem implements vscode.QuickPickItem {
	label: string
	description?: string
	detail: string
	defaultExported: boolean
	sortingKey: string

	constructor(name: string, text: string, currentFilePath: string, sourcePathList: Array<string>) {
		this.label = name === '*default' ? 'default' : name
		const sourcePath = _.last(sourcePathList)
		if (sourcePath !== currentFilePath) {
			const workspaceDirectory = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri).uri.fsPath
			this.description = _.trim(sourcePath.substring(workspaceDirectory.length), fp.sep)
		}
		this.detail = _.truncate(text, { length: 120, omission: '...' })
		this.defaultExported = name === '*default'
		this.sortingKey = name.toLowerCase()
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
		this.name = getVariableName(name, language.options)
		this.path = name
		this.language = language
	}

	async addImport(editor: vscode.TextEditor) {
		const options = this.language.options
		const document = editor.document

		const codeTree = JavaScript.parse(document)

		const existingImports = getExistingImports(codeTree)
		const duplicateImport = existingImports.find(item => item.path === this.path)
		if (duplicateImport) {
			vscode.window.showErrorMessage(`The module "${this.path}" has been already imported.`, { modal: true })
			focusAt(duplicateImport.node, document)
			return null
		}

		const importClause = this.language.checkIfImportDefaultIsPreferredOverNamespace()
			? this.name
			: `* as ${this.name}`

		const snippet = await getImportOrRequireSnippet(this.name, importClause, this.path, options, codeTree, document)
		await editor.edit(worker => worker.insert(getInsertionPosition(existingImports, this.path, document), snippet))
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

async function matchNearbyFiles<T>(filePath: string, matcher: (codeTree: ts.SourceFile, stopPropagation?: boolean) => Promise<T>, defaultValue: T): Promise<T> {
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

	return defaultValue
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

	return matchNearbyFiles(codeTree.fileName, getQuoteCharacter, '"')
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

	return matchNearbyFiles(codeTree.fileName, hasSemiColon, true)
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

	return matchNearbyFiles(codeTree.fileName, hasImportSyntax, false)
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
					if (transitIdentifiers.has('*default')) {
						const { text, pathList } = transitIdentifiers.get('*default')
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
					exportedNames.set('*default', { text, pathList: [filePath, ...pathList] })
				} else {
					exportedNames.set('*default', { text: node.getText(), pathList: [filePath] })
				}

			} else if (
				(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) &&
				node.modifiers && node.modifiers.length > 0 && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword
			) {
				if (node.modifiers.length > 1 && node.modifiers[1].kind === ts.SyntaxKind.DefaultKeyword) {
					// export default function () {}
					// export default function named () {}
					exportedNames.set('*default', { text: node.getText(), pathList: [filePath] })

				} else if (node.name) {
					// export function named () {}
					// export class named {}
					// export interface named {}
					// export type named = ...
					// export enum named = ...
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
					exportedNames.set('*default', { text, pathList: [filePath, ...pathList] })
				} else {
					exportedNames.set('*default', { text: node.getText(), pathList: [filePath] })
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

function getInsertionPosition(existingImports: Array<ImportStatementForReadOnly>, path: string, document: vscode.TextDocument) {
	if (existingImports.length > 0) {
		if (path.startsWith('.')) {
			const fileImportList = existingImports.filter(stub => stub.path.startsWith('.'))
			const targetImport = _.find(fileImportList, stub => stub.path.localeCompare(path) === 1)
			if (targetImport) {
				return document.positionAt(targetImport.node.getStart())
			} else if (fileImportList.length > 0) {
				return document.positionAt(_.last(fileImportList).node.getEnd()).translate({ lineDelta: +1 }).with({ character: 0 })
			} else {
				return document.positionAt(_.last(existingImports).node.getEnd()).translate({ lineDelta: +1 }).with({ character: 0 })
			}

		} else {
			const nodeImportList = existingImports.filter(stub => stub.path.startsWith('.') === false)
			const targetImport = _.find(nodeImportList, stub => stub.path.localeCompare(path) === 1)
			if (targetImport) {
				return document.positionAt(targetImport.node.getStart())
			} else if (nodeImportList.length > 0) {
				return document.positionAt(_.last(nodeImportList).node.getEnd()).translate({ lineDelta: +1 }).with({ character: 0 })
			} else {
				return document.positionAt(_.first(existingImports).node.getStart())
			}
		}
	}

	return new vscode.Position(0, 0)
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

// Copy from https://mathiasbynens.be/demo/javascript-identifier-regex
const validJavaScriptIdentifier = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|null|this|true|void|with|await|break|catch|class|const|false|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)(?:[\$A-Z_a-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B4\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FD5\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AD\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF30-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDEC0-\uDEF8]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F]|\uD82C[\uDC00\uDC01]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1]|\uD87E[\uDC00-\uDE1D])(?:[\$0-9A-Z_a-z\xAA\xB5\xB7\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u08A0-\u08B4\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D01-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1369-\u1371\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1CD0-\u1CD2\u1CD4-\u1CF6\u1CF8\u1CF9\u1D00-\u1DF5\u1DFC-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200C\u200D\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FD5\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AD\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF30-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDEC0-\uDEF8]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F]|\uD82C[\uDC00\uDC01]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF])*$/
