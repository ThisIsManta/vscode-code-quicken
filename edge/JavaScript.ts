import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import * as babylon from 'babylon'

import { Configuration, Language, Item } from './global';
import FileInfo from './FileInfo'

export interface LanguageOptions {
	preferImports: boolean
	removeFileExtension: boolean
	removeIndexFile: boolean
	removeSemiColons: boolean
	preferSingleQuotes: boolean
	groupImports: boolean
	namingConvention: 'camelCase' | 'snake_case' | 'lowercase' | 'as-is'
	predefinedNames: object
}

let fileCache: Array<FileItem>
let nodeCache: Array<NodeItem>

export default class JavaScript implements Language {
	support = /(java|type)script(react)?/

	async getItems(conf: Configuration) {
		let items: Array<vscode.QuickPickItem>

		const currentFileInfo = new FileInfo(vscode.window.activeTextEditor.document.fileName)

		if (!fileCache) {
			// const exclusionList = vscode.workspace.getConfiguration('files').get('exclude')
			// exclude binary, typescript (if current doc is JS)
			const fileList = await vscode.workspace.findFiles('**/*', /* '{' + exclusionList.join(',') + '}' */)
			fileCache = fileList
				.map(fileLink => new FileInfo(fileLink.fsPath))
				.filter(fileInfo => fileInfo.fileExtensionWithoutLeadingDot === 'js')
				.map(fileInfo => new FileItem(fileInfo, conf))
		}
		items = _.chain(fileCache)
			.reject(item => item.fileInfo.fullPath === currentFileInfo.fullPath) // Remove the current file
			.uniq() // Remove duplicate files
			.forEach(item => item.updateSortablePath(currentFileInfo.directoryPath))
			.sortBy([ // Sort files by their path and name
				item => item.sortablePath,
				item => item.sortableName,
			])
			.value()

		if (!nodeCache && fs.existsSync(fp.join(vscode.workspace.rootPath, 'package.json'))) {
			const packageJson = require(fp.join(vscode.workspace.rootPath, 'package.json'))

			nodeCache = _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
				.flatten<string>()
				.map(name => new NodeItem(name, conf.javascript))
				.sortBy(item => item.name)
				.value()
		}
		items = items.concat(nodeCache || [])

		return items
	}

	reset() {
		fileCache = null
		nodeCache = null
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
	private conf: Configuration
	readonly label: string
	readonly description: string
	readonly fileInfo: FileInfo
	sortablePath: string
	readonly sortableName: string

	constructor(fileInfo: FileInfo, conf: Configuration) {
		this.fileInfo = fileInfo
		this.conf = conf

		if (this.conf.javascript.removeIndexFile && this.fileInfo.fileNameWithoutExtension === 'index') {
			this.label = this.fileInfo.directoryName
		} else if (this.conf.javascript.removeFileExtension) {
			this.label = this.fileInfo.fileNameWithoutExtension
		} else {
			this.label = this.fileInfo.fileNameWithExtension
		}

		this.description = _.trim(fp.dirname(this.fileInfo.fullPath.substring(vscode.workspace.rootPath.length)), fp.sep)

		if (this.fileInfo.fileNameWithoutExtension === 'index') {
			this.sortableName = '!'
		} else {
			this.sortableName = this.fileInfo.fileNameWithExtension.toLowerCase()
		}
	}

	updateSortablePath(currentDirectoryPath: string) {
		if (vscode.workspace.textDocuments.find(document => document.fileName === this.fileInfo.fullPath) !== undefined) {
			this.sortablePath = 'a'

		} else if (this.fileInfo.directoryPath === currentDirectoryPath) {
			this.sortablePath = 'b'

		} else {
			this.sortablePath = this.fileInfo.getRelativePath(currentDirectoryPath).split('/').map((chunk, index, array) => {
				if (chunk === '.') return 'c'
				else if (chunk === '..') return 'f'
				else if (index === array.length - 1 && index > 0 && array[index - 1] === '..') return 'd'
				else if (index === array.length - 1) return 'z'
				return 'e'
			}).join('')
		}
	}

	async insertImport(document: vscode.TextDocument) {
		const codeTree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(codeTree)

		const currentDirectoryPath = new FileInfo(document.fileName).directoryPath

		let top = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			top = new vscode.Position(existingImports[0].start.line - 1, existingImports[0].start.column)
		}

		if (/^(jsx?|tsx?)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			let name = getVariableName(this.fileInfo.fileNameWithoutExtension, this.conf.javascript)
			let path = this.fileInfo.getRelativePath(currentDirectoryPath)

			if (this.conf.javascript.removeIndexFile && this.fileInfo.fileNameWithoutExtension === 'index') {
				name = getVariableName(this.fileInfo.directoryName, this.conf.javascript)
				path = path.replace(new RegExp('/' + _.escapeRegExp(this.fileInfo.fileNameWithExtension) + '$'), '')

			} else if (this.conf.javascript.removeFileExtension) {
				path = path.replace(new RegExp('\\.' + _.escapeRegExp(this.fileInfo.fileExtensionWithoutLeadingDot) + '$'), '')
			}

			let done = false

			// const hasImportedDefault = duplicateImport.node.type === 'ImportDeclaration' && _.some(duplicateImport.node.specifiers, (node: any) => node.type === 'ImportDefaultSpecifier')

			if (this.conf.javascript.preferImports) {
				if (this.hasIndexFile()) {
					const exportedVariables = this.getExportedVariablesFromIndexFile()

					let indexRelativePath = new FileInfo(this.getIndexPath()).getRelativePath(currentDirectoryPath)
					if (this.fileInfo.fileNameWithoutExtension !== 'index') {
						if (this.conf.javascript.removeIndexFile) {
							indexRelativePath = fp.dirname(indexRelativePath)

						} else if (this.conf.javascript.removeFileExtension) {
							indexRelativePath = indexRelativePath.replace(new RegExp(_.escapeRegExp(fp.extname(indexRelativePath)) + '$'), '')
						}
					}

					const duplicateImportForIndexFile = findDuplicateImport(existingImports, indexRelativePath)
					const hasImportedEverything = duplicateImportForIndexFile && duplicateImportForIndexFile.node.type === 'ImportDeclaration' && duplicateImportForIndexFile.node.specifiers[0].type === 'ImportNamespaceSpecifier'
					if (exportedVariables.length > 0 && hasImportedEverything) {
						vscode.window.showInformationMessage(`The module "${name}" has been already imported from "${indexRelativePath}".`)
						// TODO: move focus to the statement
						return null
					}

					if (exportedVariables.length === 1) {
						name = exportedVariables[0]
						name = `{ ${name} }`

						if (this.fileInfo.fileNameWithoutExtension !== 'index') {
							path = indexRelativePath
						}

						done = true

					} else if (exportedVariables.length > 1) {
						name = await vscode.window.showQuickPick(['*', ...exportedVariables])

						if (!name) {
							return null
						}

						if (name === '*') {
							name = '* as ' + name
						} else {
							name = `{ ${name} }`
						}

						if (this.fileInfo.fileNameWithoutExtension !== 'index') {
							path = indexRelativePath
						}

						done = true
					}
				}

				if (done === false) {
					const codeText = fs.readFileSync(this.fileInfo.fullPath, 'utf-8')
					const codeTree = JavaScript.parse(codeText)

					const hasDefaultExport = codeTree === null || findInCodeTree(codeTree, EXPORT_DEFAULT) !== undefined || findInCodeTree(codeTree, MODULE_EXPORTS) !== undefined

					if (hasDefaultExport === false) {
						const exportedVariables = getExportedVariables(this.fileInfo.fullPath)
						if (exportedVariables.length === 0) {
							name = '* as ' + name

						} else {
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

			const duplicateImport = findDuplicateImport(existingImports, path)
			if (duplicateImport) {
				if (this.conf.javascript.groupImports && duplicateImport.node.type === 'ImportDeclaration' && name.startsWith('*') === false) {
					const originalName = name.startsWith('{')
						? name.substring(1, name.length - 1).trim() // Remove brackets from `{ name }`
						: name

					let duplicateNamedImport = null
					const nodeList = duplicateImport.node.specifiers as Array<any>
					for (let node of nodeList) {
						if (node.type === 'ImportDefaultSpecifier' && name.startsWith('{') === false) {
							duplicateNamedImport = node
							break

						} else if (node.type === 'ImportSpecifier' && node.imported.name === originalName) {
							duplicateNamedImport = node
							break
						}
					}

					if (duplicateNamedImport) {
						vscode.window.showInformationMessage(`The module "${originalName}" has been already imported.`)
						// TODO: move focus to the statement
						return null
					}

					if (name.startsWith('{')) {
						const lastNamedImport = _.findLast(nodeList, node => node.type === 'ImportSpecifier')
						if (lastNamedImport) {
							const afterLastName = new vscode.Position(lastNamedImport.loc.end.line - 1, lastNamedImport.loc.end.column)
							return (worker: vscode.TextEditorEdit) => worker.insert(afterLastName, ', ' + originalName)

						} else {
							const lastAnyImport = _.last(nodeList)
							const afterLastName = new vscode.Position(lastAnyImport.loc.end.line - 1, lastAnyImport.loc.end.column)
							return (worker: vscode.TextEditorEdit) => worker.insert(afterLastName, ', ' + name)
						}

					} else {
						// Add import default
						const beforeFirstName = new vscode.Position(duplicateImport.node.loc.start.line - 1, duplicateImport.node.loc.start.column + ('import '.length))
						return (worker: vscode.TextEditorEdit) => worker.insert(beforeFirstName, name + ', ')
					}

				} else {
					vscode.window.showInformationMessage(`The module "${name}" has been already imported.`)
					// TODO: move focus to the statement
					return null
				}
			}

			const snippet = getImportSnippet(name, path, this.conf.javascript.preferImports, this.conf.javascript, document)

			return (worker: vscode.TextEditorEdit) => worker.insert(top, snippet)

		} else if (/^(css|less|scss|styl)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			const path = this.fileInfo.getRelativePath(currentDirectoryPath)

			if (findDuplicateImport(existingImports, path)) {
				vscode.window.showInformationMessage(`The module "${this.label}" has been already imported.`)
				// TODO: move focus to the statement
				return null
			}

			const snippet = getImportSnippet(null, path, this.conf.javascript.preferImports, this.conf.javascript, document)

			return (worker: vscode.TextEditorEdit) => worker.insert(top, snippet)

		} else {
			const path = this.fileInfo.getRelativePath(currentDirectoryPath)
			const snippet = getImportSnippet(null, path, false, this.conf.javascript, document)

			return (worker: vscode.TextEditorEdit) => worker.insert(vscode.window.activeTextEditor.selection.active, snippet)
		}
	}

	private getIndexPath() {
		return fp.resolve(this.fileInfo.directoryPath, 'index.' + this.fileInfo.fileExtensionWithoutLeadingDot)

		/* const extn = this.fileInfo.fileExtensionWithoutLeadingDot
		let pathList: Array<string> = []

		if (extn.startsWith('ts')) {
			if (extn.endsWith('x')) {
				pathList.push(fp.resolve(this.fileInfo.directoryPath, 'index.tsx'))
			}
			pathList.push(fp.resolve(this.fileInfo.directoryPath, 'index.ts'))
		}

		if (extn.startsWith('js')) {
			if (extn.endsWith('x')) {
				pathList.push(fp.resolve(this.fileInfo.directoryPath, 'index.jsx'))
			}
			pathList.push(fp.resolve(this.fileInfo.directoryPath, 'index.js'))
		}

		return pathList.find(path => fs.existsSync(path)) || '' */
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
	private conf: LanguageOptions
	readonly label: string
	readonly description: string = ''
	readonly name: string
	readonly path: string

	constructor(name: string, conf: LanguageOptions) {
		this.label = name
		this.name = getVariableName(name, conf)
		this.path = name

		this.conf = conf

		try {
			const packageJson = require(fp.join(vscode.workspace.rootPath, 'node_modules', name, 'package.json'))
			if (packageJson.version) {
				this.description = 'v' + packageJson.version
			}
		} catch (ex) { }
	}

	async insertImport(document: vscode.TextDocument) {
		let name = this.name
		if (/typescript(react)?/.test(document.languageId)) {
			name = `* as ${name}`
		}

		const snippet = getImportSnippet(name, this.path, this.conf.preferImports, this.conf, document)

		const tree = JavaScript.parse(document.getText())

		const existingImports = getExistingImports(tree)

		if (existingImports.find(item => item.path === this.path)) {
			vscode.window.showInformationMessage(`The module "${this.path}" has been already imported.`)
			return null
		}

		let position = new vscode.Position(0, 0)
		if (existingImports.length > 0) {
			position = new vscode.Position(existingImports[0].start.line - 1, existingImports[0].start.column)
		}

		return (worker: vscode.TextEditorEdit) => worker.insert(position, snippet)
	}
}

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

interface ImportStatement {
	node: any,
	// name?: string | Array<string>,
	path: string,
	start: { line: number, column: number },
	end: { line: number, column: number },
}

function getExistingImports(codeTree: any) {
	let imports: ImportStatement[] = []
	if (codeTree && codeTree.program && codeTree.program.body) {
		// For `import '...'`
		//     `import name from '...'`
		//     `import { name } from '...'`
		imports = imports.concat(codeTree.program.body
			.filter((line: any) => line.type === 'ImportDeclaration' && line.source && line.source.type === 'StringLiteral')
			.map((stub: any) => ({
				node: stub,
				...stub.loc,
				// name: _.get(_.find(stub.specifiers, (spec: any) => spec.type === 'ImportDefaultSpecifier'), 'local.name'),
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
					// name: stub.id.name,
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

function getVariableName(name: string, conf: LanguageOptions) {
	const predefinedNames = _.toPairs(conf.predefinedNames)
	for (let pair of predefinedNames) {
		if (pair[0].startsWith('/') && pair[0].substring(1).includes('/')) {
			const regx = new RegExp(pair[0].substring(1, pair[0].length - 1), pair[0].substring(pair[0].lastIndexOf('/') + 1))
			if (regx.test(name)) {
				return name.replace(regx, pair[1])
			}

		} else if (pair[0] === name) {
			return pair[1]
		}
	}

	if (conf.namingConvention === 'camelCase') {
		return _.camelCase(name) || name

	} else if (conf.namingConvention === 'snake_case') {
		return _.snakeCase(name) || name

	} else if (conf.namingConvention === 'lowercase') {
		return name.toLowerCase()

	} else {
		return name
	}
}

function getImportSnippet(name: string, path: string, useImport: boolean, conf: LanguageOptions, document: vscode.TextDocument) {
	if (conf.preferSingleQuotes) {
		path = `'${path}'`
	} else {
		path = `"${path}"`
	}

	let code = ''
	if (useImport) {
		if (name) {
			code = `import ${name} from ${path}`
		} else {
			code = `import ${path}`
		}

	} else {
		if (name) {
			code = `const ${name} = require(${path})`
		} else {
			code = `require(${path})`
		}
	}

	return code + (conf.removeSemiColons ? '' : ';') + (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')
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

function getFilePathWithExtension(extn: string, ...path: string[]) {
	const filePath = fp.resolve(...path)

	if (fs.existsSync(filePath)) {
		return filePath
	}

	/* if (extn.startsWith('ts')) {
		if (extn.endsWith('x') && fs.existsSync(filePath + '.tsx')) return filePath + '.tsx'
		if (fs.existsSync(filePath + '.ts')) return filePath + '.ts'
	}

	if (extn.startsWith('ts') || extn.startsWith('js')) {
		if (extn.endsWith('x') && fs.existsSync(filePath + '.jsx')) return filePath + '.jsx'
		if (fs.existsSync(filePath + '.js')) return filePath + '.js'
	} */

	return filePath + '.' + extn
}

function findDuplicateImport(existingImports: Array<ImportStatement>, path: string) {
	return existingImports.find(stub => stub.path === path)

	/* for (let item of existingImports) {
		if ((item.path.startsWith('./') || item.path.startsWith('../')) === false) {
			continue
		}

		if (item.path === target) {
			return true
		}

		// const path = getFilePathWithExtension(fileExtn, dirxPath, item.path)

		let fileList = FileInfo.resolve(document.fileName, '..', item.path)
		if (fileList.length === 0) {
			continue
		}

		if (fileList.some(fileInfo => fileInfo.fullPath === target)) {
			return true
		}
	}

	return false */
}
