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
	quoteCharacter: 'single' | 'double'
	semiColons: boolean
	predefinedVariableNames: object
	variableNamingConvention: 'camelCase' | 'PascalCase' | 'snake_case' | 'lowercase' | 'none'
	filteredFileList: object
}

export interface ExclusiveLanguageOptions extends LanguageOptions {
	allowTypeScriptFiles: boolean
}

const TYPESCRIPT_EXTENSION = /^tsx?$/

export default class JavaScript implements Language {
	protected baseConfig: RootConfigurations
	private fileItemCache: Array<FileItem>
	private nodeItemCache: Array<NodeItem>

	protected WORKING_LANGUAGE = /^javascript(react)?/i
	protected WORKING_EXTENSION = /^jsx?$/
	protected allowTypeScriptFiles = false

	constructor(baseConfig: RootConfigurations) {
		this.baseConfig = baseConfig

		const exclusiveConfig: ExclusiveLanguageOptions = this.baseConfig.javascript
		if (exclusiveConfig && exclusiveConfig.allowTypeScriptFiles) {
			this.allowTypeScriptFiles = true

			this.WORKING_EXTENSION = /^(j|t)sx?$/
		}
	}

	protected getLanguageOptions() {
		return this.baseConfig.javascript as LanguageOptions
	}

	async getItems(document: vscode.TextDocument) {
		if (this.WORKING_LANGUAGE.test(document.languageId) === false) {
			return null
		}

		const documentFileInfo = new FileInfo(document.fileName)
		const rootPath = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath

		if (!this.fileItemCache) {
			const fileLinks = await vscode.workspace.findFiles('**/*.*')

			this.fileItemCache = fileLinks
				.map(fileLink => new FileItem(fileLink.fsPath, rootPath, this.getLanguageOptions(), this.WORKING_EXTENSION))
		}

		const fileFilterRule = _.toPairs(this.getLanguageOptions().filteredFileList)
			.map((pair: Array<string>) => ({ documentPathPattern: new RegExp(pair[0]), filePathPattern: new RegExp(pair[1]) }))
			.find(rule => rule.documentPathPattern.test(documentFileInfo.fullPathForPOSIX))

		const filteredItems: Array<Item> = []
		for (const item of this.fileItemCache) {
			if (this.allowTypeScriptFiles === false && TYPESCRIPT_EXTENSION.test(item.fileInfo.fileExtensionWithoutLeadingDot)) {
				continue
			}

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

		let packageJsonPath = _.trimEnd(fp.dirname(document.fileName), fp.sep)
		while (packageJsonPath !== rootPath && fs.existsSync(fp.join(packageJsonPath, 'package.json')) === false) {
			const pathList = packageJsonPath.split(fp.sep)
			pathList.pop()
			packageJsonPath = pathList.join(fp.sep)
		}
		packageJsonPath = fp.join(packageJsonPath, 'package.json')

		if (!this.nodeItemCache && fs.existsSync(packageJsonPath)) {
			const packageJson = require(packageJsonPath)

			this.nodeItemCache = _.chain([packageJson.devDependencies, packageJson.dependencies])
				.map(_.keys)
				.flatten<string>()
				.map(name => new NodeItem(name, rootPath, this.getLanguageOptions()))
				.sortBy(item => item.name)
				.value()
		}

		return [...sortedItems, ...(this.nodeItemCache || [])] as Array<Item>
	}

	addItem(filePath: string) {
		if (this.fileItemCache) {
			const rootPath = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)).uri.fsPath
			this.fileItemCache.push(new FileItem(filePath, rootPath, this.getLanguageOptions(), this.WORKING_EXTENSION))
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
		if (this.WORKING_LANGUAGE.test(document.languageId) === false) {
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
			findRequireRecursively(codeTree)
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
					const { path } = new FileItem(matchingFullPaths[0], rootPath, this.getLanguageOptions(), this.WORKING_EXTENSION).getNameAndRelativePath(documentFileInfo.directoryPath)
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
				const { path } = new FileItem(selectedItem.fullPath, rootPath, this.getLanguageOptions(), this.WORKING_EXTENSION).getNameAndRelativePath(documentFileInfo.directoryPath)
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

	static async fixESLint() {
		const commands = await vscode.commands.getCommands()
		if (commands.indexOf('eslint.executeAutofix') >= 0) {
			await vscode.commands.executeCommand('eslint.executeAutofix')
		}
	}

	reset() {
		this.fileItemCache = null
		this.nodeItemCache = null
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
	private options: LanguageOptions
	private extension: RegExp
	readonly id: string
	readonly label: string
	readonly description: string
	readonly fileInfo: FileInfo
	sortablePath: string
	sortableName: string

	constructor(filePath: string, rootPath: string, options: LanguageOptions, extension: RegExp) {
		this.fileInfo = new FileInfo(filePath)
		this.id = this.fileInfo.fullPath
		this.options = options
		this.extension = extension

		// Set containing directory of the given file
		this.description = _.trim(fp.dirname(this.fileInfo.fullPath.substring(rootPath.length)), fp.sep).replace(/\\/g, '/')

		if (this.options.indexFile && this.checkIfIndexPath(this.fileInfo.fileNameWithExtension)) {
			this.label = this.fileInfo.directoryName
			this.description = _.trim(this.fileInfo.fullPath.substring(rootPath.length), fp.sep).replace(/\\/g, '/')
		} else if (this.options.fileExtension === false && this.extension.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
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

	getNameAndRelativePath(directoryPathOfWorkingDocument: string) {
		let name = getVariableName(this.fileInfo.fileNameWithoutExtension, this.options)
		let path = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument)

		if (this.options.indexFile && this.checkIfIndexPath(this.fileInfo.fileNameWithExtension)) {
			// Set the imported variable name to the directory name
			name = getVariableName(this.fileInfo.directoryName, this.options)

			// Remove "/index.js" from the imported path
			path = fp.dirname(path)

		} else if (this.options.fileExtension === false && this.extension.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			// Remove file extension from the imported path only if it matches the working document
			path = path.replace(new RegExp('\\.' + _.escapeRegExp(this.fileInfo.fileExtensionWithoutLeadingDot) + '$'), '')
		}

		return { name, path }
	}

	async addImport(editor: vscode.TextEditor) {
		const document = editor.document

		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)

		const directoryPathOfWorkingDocument = new FileInfo(document.fileName).directoryPath

		let beforeFirstImport = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			beforeFirstImport = document.positionAt(existingImports[0].node.pos)
		}

		// For JS/TS, insert `import ... from "file.js" with rich features`
		// For CSS/LESS/SASS/SCSS/Styl, insert `import "file.css"`
		// Otherwise, insert `require("...")`
		if (this.extension.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			// Set default imported variable name and its path
			let { name, path } = this.getNameAndRelativePath(directoryPathOfWorkingDocument)
			let iden = name

			let foundIndexFileAndWentForIt = false

			if (this.options.syntax === 'import') {
				if (this.hasIndexFile()) {
					const exportedVariables = this.getExportedVariablesFromIndexFile()

					let indexFileRelativePath = new FileInfo(this.getIndexPath()).getRelativePath(directoryPathOfWorkingDocument)
					if (this.options.indexFile === false) {
						indexFileRelativePath = fp.dirname(indexFileRelativePath)

					} else if (this.options.fileExtension === false) {
						indexFileRelativePath = indexFileRelativePath.replace(new RegExp(_.escapeRegExp(fp.extname(indexFileRelativePath)) + '$'), '')
					}

					const duplicateImportForIndexFile = getDuplicateImport(existingImports, indexFileRelativePath)
					const duplicateImportHasImportedEverything = _.isMatch(duplicateImportForIndexFile && duplicateImportForIndexFile.node, IMPORT_EVERYTHING)

					// Stop processing if there is `import * as name from "path"`
					if (exportedVariables.length > 0 && duplicateImportHasImportedEverything) {
						vscode.window.showInformationMessage(`The module "${name}" has been already imported from "${indexFileRelativePath}".`)
						focusAt(duplicateImportForIndexFile.node, document)
						return null
					}

					if (exportedVariables.length === 1) {
						// Set `import { name } from "path/index.js"` when the index file exports only one
						iden = exportedVariables[0]
						name = `{ ${iden} }`

						path = indexFileRelativePath

						foundIndexFileAndWentForIt = true

					} else if (exportedVariables.length > 1) {
						// Let the user choose between `import * as name from "path/index.js"` or `import { name } from "path/index.js"`
						const selectedName = await vscode.window.showQuickPick(['*', ...exportedVariables])

						if (!selectedName) {
							return null
						}

						if (selectedName === '*') {
							name = '* as ' + iden
						} else {
							iden = selectedName
							name = '{ ' + iden + ' }'
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
						codeTree.statements.some(node => ts.isExportAssignment(node)) ||
						codeTree.statements.some(node => _.isMatch(node, MODULE_EXPORTS_DEFAULT))
					)

					if (foreignFileHasDefaultExport === false) {
						const exportedVariables = getExportedVariables(this.fileInfo.fullPath)
						if (exportedVariables.length === 0) {
							// Set `import * as name from "path"` when the file does not export anything
							name = '* as ' + iden

						} else {
							// Let the user choose between `import * as name from "path"` or `import { name } from "path"`
							const selectedName = await vscode.window.showQuickPick(['*', ...exportedVariables])

							if (!selectedName) {
								return null
							}

							if (selectedName === '*') {
								name = '* as ' + iden
							} else {
								iden = selectedName
								name = '{ ' + iden + ' }'
							}
						}
					}
				}
			}

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				// Try merging the given named import with the existing imports
				if (this.options.grouping && ts.isImportDeclaration(duplicateImport.node) && duplicateImport.node.importClause) {
					// There are 9 cases as a product of 3 by 3 cases:
					// 1) `import default from "path"`
					// 2) `import * as namespace from "path"`
					// 3) `import { named } from "path"`

					if (name.startsWith('*')) {
						if (duplicateImport.node.importClause.name) {
							// Try merging `* as namespace` with `default`
							const position = document.positionAt(duplicateImport.node.importClause.name.end)
							await editor.edit(worker => worker.insert(position, ', ' + name))
							await JavaScript.fixESLint()
							return null

						} else {
							// Try merging `* as namespace` with `* as namespace`
							// Try merging `* as namespace` with `{ named }`
							vscode.window.showInformationMessage(`The module "${iden}" has been already imported.`)
							focusAt(duplicateImport.node.importClause.namedBindings, document)
							return null
						}

					} else if (name.startsWith('{')) {
						if (duplicateImport.node.importClause.name) {
							// Try merging `{ named }` with `default`
							const position = document.positionAt(duplicateImport.node.importClause.name.end)
							await editor.edit(worker => worker.insert(position, ', ' + name))
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
							if (duplicateImport.node.importClause.namedBindings.elements.some(node => node.name.text === iden)) {
								vscode.window.showInformationMessage(`The module "${iden}" has been already imported.`)
								focusAt(duplicateImport.node, document)
								return null

							} else {
								if (duplicateImport.node.importClause.namedBindings.elements.length > 0) {
									const position = document.positionAt(_.last(duplicateImport.node.importClause.namedBindings.elements).end)
									await editor.edit(worker => worker.insert(position, ', ' + iden))
									await JavaScript.fixESLint()
									return null

								} else {
									const position = document.positionAt(duplicateImport.node.importClause.namedBindings.end - 1)
									await editor.edit(worker => worker.insert(position, iden))
									await JavaScript.fixESLint()
									return null
								}
							}
						}

					} else { // In case of `import default from "path"`
						if (duplicateImport.node.importClause.name) {
							// Try merging `default` with `default`
							vscode.window.showInformationMessage(`The module "${iden}" has been already imported.`)
							focusAt(duplicateImport.node, document)
							return null

						} else {
							// Try merging `default` with `* as namespace`
							// Try merging `default` with `{ named }`
							const position = document.positionAt(duplicateImport.node.importClause.namedBindings.pos)
							await editor.edit(worker => worker.insert(position, name + ', '))
							await JavaScript.fixESLint()
							return null
						}
					}

				} else {
					vscode.window.showInformationMessage(`The module "${iden}" has been already imported.`)
					focusAt(duplicateImport.node, document)
					return null
				}
			}

			/* const existingVariableHash = _.chain(existingImports)
				.map(item => {
					if (ts.isImportDeclaration(item.node)) {
						return item.node.specifiers.map(spec => [_.get(spec, 'local.name', ''), item])
					}
				})
				.compact()
				.flatten()
				.reject(pair => pair[0] === '')
				.fromPairs()
				.value()
			const duplicateVariable = existingVariableHash[iden] as ImportStatementForReadOnly
			if (duplicateVariable) {
				const options: Array<vscode.MessageItem> = [
					{ title: 'Replace It' },
					{ title: 'Keep Both', isCloseAffordance: true }
				]
				const selectedOption = await vscode.window.showWarningMessage(`Do you want to replace the existing "${iden}"?`, { modal: true }, ...options)
				if (selectedOption === options[0]) {
					await editor.edit(worker => worker.delete(new vscode.Range(duplicateVariable.start.line - 1, duplicateVariable.start.column, duplicateVariable.end.line - 1, duplicateVariable.end.column)))
				}
			} */

			const snippet = getImportSnippet(name, path, this.options.syntax === 'import', this.options, document)
			await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
			await JavaScript.fixESLint()
			return null

		} else if (/^(css|less|sass|scss|styl)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const { path } = this.getNameAndRelativePath(directoryPathOfWorkingDocument)

			const duplicateImport = getDuplicateImport(existingImports, path)
			if (duplicateImport) {
				vscode.window.showInformationMessage(`The module "${this.label}" has been already imported.`)
				focusAt(duplicateImport.node, document)
				return null
			}

			const snippet = getImportSnippet(null, path, this.options.syntax === 'import', this.options, document)
			await editor.edit(worker => worker.insert(beforeFirstImport, snippet))
			await JavaScript.fixESLint()
			return null

		} else {
			const { path } = this.getNameAndRelativePath(directoryPathOfWorkingDocument)
			const snippet = getImportSnippet(null, path, false, this.options, document)
			await editor.edit(worker => worker.insert(vscode.window.activeTextEditor.selection.active, snippet))
			await JavaScript.fixESLint()
			return null
		}
	}

	private checkIfIndexPath(fileNameWithExtension: string) {
		const parts = fileNameWithExtension.split('.')
		return parts.length === 2 && parts[0] === 'index' && this.extension.test(parts[1])
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

			const importedVariableSourceDict = codeTree.statements
				.filter(node => ts.isImportDeclaration(node))
				.reduce((hash, node: ts.ImportDeclaration) => {
					const relaPath = (node.moduleSpecifier as ts.StringLiteral).text
					const fullPath = fp.resolve(this.fileInfo.directoryPath, relaPath)
					if (node.importClause.name) {
						hash[node.importClause.name.text] = fullPath
					}
					if (ts.isNamedImports(node.importClause.namedBindings)) {
						for (const stub of node.importClause.namedBindings.elements) {
							hash[stub.name.text] = fullPath
						}
					} else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
						hash[node.importClause.namedBindings.name.text] = fullPath
					}
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

			codeTree.forEachChild(node => {
				if (ts.isExportDeclaration(node)) {
					if (ts.isNamedExports(node.exportClause)) {
						for (const stub of node.exportClause.elements) {
							const name = stub.name.text
							const path = node.moduleSpecifier
								? (node.moduleSpecifier as ts.StringLiteral).text
								: importedVariableSourceDict[name]
							save(name, path)
						}

					} else if (!node.exportClause && node.moduleSpecifier) {
						const path = getFilePathWithExtension(this.fileInfo.fileExtensionWithoutLeadingDot, this.fileInfo.directoryPath, (node.moduleSpecifier as ts.StringLiteral).text)
						getExportedVariables(path).forEach(name => {
							save(name, path)
						})
					}
				}
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

	constructor(name: string, rootPath: string, options: LanguageOptions) {
		this.id = 'node://' + name
		this.label = name
		this.name = getVariableName(name, options)
		this.path = name

		this.options = options

		// Set version of the module as the description
		try {
			const packageJson = require(fp.join(rootPath, 'node_modules', name, 'package.json'))
			if (packageJson.version) {
				this.description = 'v' + packageJson.version
			}
		} catch (ex) { }
	}

	async addImport(editor: vscode.TextEditor) {
		const document = editor.document

		let name = this.name
		if (/typescript(react)?/.test(document.languageId)) {
			const tsConfigPaths = await vscode.workspace.findFiles('**/tsconfig.json')
			const tsConfigPath = tsConfigPaths.find(file => document.uri.fsPath.startsWith(fp.dirname(file.fsPath)))
			let esModuleInterop = false
			if (tsConfigPath) {
				const tsConfig = JSON.parse(fs.readFileSync(tsConfigPath.fsPath, 'utf-8'))
				esModuleInterop = _.get<boolean>(tsConfig, 'compilerOptions.esModuleInterop', false)
			}

			if (esModuleInterop === false) {
				name = `* as ${name}`
			}
		}

		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)
		const duplicateImport = existingImports.find(item => item.path === this.path)
		if (duplicateImport) {
			vscode.window.showInformationMessage(`The module "${this.path}" has been already imported.`)
			focusAt(duplicateImport.node, document)
			return null
		}

		let position = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			position = document.positionAt(existingImports[0].node.pos)
		}

		const snippet = getImportSnippet(name, this.path, this.options.syntax === 'import', this.options, document)
		await editor.edit(worker => worker.insert(position, snippet))
		await JavaScript.fixESLint()
	}
}

export const MODULE_EXPORTS_DEFAULT = {
	kind: ts.SyntaxKind.ExpressionStatement,
	expression: {
		kind: ts.SyntaxKind.BinaryExpression,
		operatorToken: {
			kind: ts.SyntaxKind.EqualsToken,
		},
		left: {
			kind: ts.SyntaxKind.PropertyAccessExpression,
			expression: {
				kind: ts.SyntaxKind.Identifier,
				text: 'module',
			},
			name: {
				kind: ts.SyntaxKind.Identifier,
				text: 'exports',
			},
		}
	}
}

export const MODULE_REQUIRE_IMMEDIATE = {
	kind: ts.SyntaxKind.CallExpression,
	expression: {
		kind: ts.SyntaxKind.Identifier,
		text: 'require'
	},
	arguments: [
		{
			kind: ts.SyntaxKind.StringLiteral
		}
	]
}

export const MODULE_REQUIRE = {
	kind: ts.SyntaxKind.VariableDeclaration,
	initializer: MODULE_REQUIRE_IMMEDIATE
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
				if (_.isMatch(node, MODULE_REQUIRE)) {
					imports.push({ node, path: _.get(node, 'initializer.arguments.0.text') })
				}
			})

		} else if (ts.isExpressionStatement(node) && _.isMatch(node.expression, MODULE_REQUIRE_IMMEDIATE)) {
			// For `require('...')`
			imports.push({ node, path: _.get(node, 'expression.arguments.0.text') })
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

function getImportSnippet(name: string, path: string, useImport: boolean, options: LanguageOptions, document: vscode.TextDocument) {
	if (options.quoteCharacter === 'single') {
		path = `'${path}'`
	} else {
		path = `"${path}"`
	}

	const lineEnding = (options.semiColons ? ';' : '') + (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')

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

function getExportedVariables(filePath: string): Array<string> {
	const fileExtension = _.trimStart(fp.extname(filePath), '.')
	try {
		const codeTree = JavaScript.parse(fs.readFileSync(filePath, 'utf-8'))
		return _.chain(codeTree.statements)
			.map(node => {
				if (ts.isExportDeclaration(node)) {
					if (node.exportClause) {
						// export { ... }
						return node.exportClause.elements.map(stub => stub.name.text)

					} else if (node.moduleSpecifier) {
						// export * from '...'
						return getExportedVariables(getFilePathWithExtension(fileExtension, filePath, (node.moduleSpecifier as ts.StringLiteral).text))
					}

				} else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.modifiers && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword && node.modifiers[1].kind !== ts.SyntaxKind.DefaultKeyword && node.name) {
					// export default function () {}
					// export default class {}
					return node.name.text

				} else if (ts.isVariableStatement(node) && node.modifiers && node.modifiers[0].kind === ts.SyntaxKind.ExportKeyword) {
					// export const ...
					return node.declarationList.declarations.map(stub => stub.name.getText())

				} else if (ts.isExportAssignment(node) && ts.isObjectLiteralExpression(node.expression)) {
					// export default { ... }
					return node.expression.properties
						.filter(stub => ts.isPropertyAssignment(stub))
						.map(stub => stub.name.getText())

				} else if (_.isMatch(node, MODULE_EXPORTS_DEFAULT) && ts.isObjectLiteralExpression(((node as ts.ExpressionStatement).expression as ts.BinaryExpression).right)) {
					// module.exports = ...
					return (((node as ts.ExpressionStatement).expression as ts.BinaryExpression).right as ts.ObjectLiteralExpression).properties
						.filter(stub => ts.isPropertyAssignment(stub))
						.map(stub => stub.name.getText())

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
					return node.expression.left.name.text
				}
			})
			.flatten()
			.compact()
			.value() as Array<string>

	} catch (ex) {
		console.error(ex)
	}

	return []
}

// TODO: expectedFileExtension should be an array of js/ts
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

function findRequireRecursively(node: ts.Node, results: Array<ts.CallExpression> = [], visited = new Set<ts.Node>()) {
	if (visited.has(node)) {
		return results

	} else {
		visited.add(node)
	}

	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
		results.push(node)
		return results

	} else {
		node.forEachChild(stub => {
			findRequireRecursively(stub, results, visited)
		})
	}

	return results
}

function focusAt(node: { pos: number, end: number }, document: vscode.TextDocument) {
	vscode.window.activeTextEditor.revealRange(
		new vscode.Range(
			document.positionAt(node.pos),
			document.positionAt(node.end)
		),
		vscode.TextEditorRevealType.InCenterIfOutsideViewport
	)
}