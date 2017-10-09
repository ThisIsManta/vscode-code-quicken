import * as vscode from 'vscode'
import * as fp from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import FileInfo from './FileInfo'
import * as Shared from './Shared'

export default class FileItem implements vscode.QuickPickItem {
	readonly label: string
	readonly description: string
	readonly fileInfo: FileInfo
	sortablePath: string
	readonly sortableName: string

	constructor(fileLink: vscode.Uri) {
		this.fileInfo = new FileInfo(fileLink.fsPath)

		this.label = this.fileInfo.fileNameWithoutExtension === 'index' ? this.fileInfo.directoryName : this.fileInfo.fileNameWithExtension
		this.description = _.trim(fp.dirname(fileLink.fsPath.substring(vscode.workspace.rootPath.length)), fp.sep)

		this.sortableName = this.fileInfo.fileNameWithoutExtension === 'index' ? '!' : this.fileInfo.fileNameWithExtension.toLowerCase()

		resolveFileExtn.cache.clear()
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

	private getIndexPath() {
		return fp.resolve(this.fileInfo.directoryPath, 'index.' + this.fileInfo.fileExtensionWithoutLeadingDot)
	}

	hasIndexFile() {
		return fs.existsSync(this.getIndexPath())
	}

	getExportedVariablesFromCurrentFile(plugins = []) {
		return this.getExportedVariables(this.fileInfo.fullPath, plugins)
	}

	private getExportedVariables(filePath: string, plugins: Array<string>) {
		try {
			const codeTree = Shared.getCodeTree(fs.readFileSync(filePath, 'utf-8'), this.fileInfo.fileExtensionWithoutLeadingDot, plugins)

			return _.chain(codeTree.program.body)
				.map(node => {
					if (node.type === 'ExportNamedDeclaration') {
						if (node.declaration && node.declaration.type === 'FunctionDeclaration') {
							return node.declaration.id.name

						} else if (node.declaration && node.declaration.type === 'VariableDeclaration') {
							return node.declaration.declarations.map(item => item.id.name)

						} else if (node.specifiers) {
							return node.specifiers.map(item => item.exported ? item.exported.name : item.local.name)
						}

					} else if (node.type === 'ExportAllDeclaration' && node.source.value) {
						return this.getExportedVariables(resolveFileExtn(this.fileInfo.fileExtensionWithoutLeadingDot, filePath, node.source.value), plugins)

					} else if (_.isMatch(node, Shared.MODULE_EXPORTS) && node.expression.right.type === 'ObjectExpression') {
						return node.expression.right.properties.map(item => item.key.name)
					}
				})
				.flatten()
				.compact()
				.reject(name => name === 'default')
				.value()

		} catch (ex) {
			console.error(ex)
		}

		return []
	}

	getExportedVariablesFromIndexFile(plugins = []) {
		try {
			const codeTree = Shared.getCodeTree(fs.readFileSync(this.getIndexPath(), 'utf-8'), this.fileInfo.fileExtensionWithoutLeadingDot, plugins)

			const importedVariableSourceDict = codeTree.program.body.filter(node => node.type === 'ImportDeclaration')
				.reduce((hash, node) => {
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
				.forEach(node => {
					node.specifiers.forEach(item => {
						if (item => item.type === 'ExportSpecifier' && item.local && item.local.type === 'Identifier') {
							const name = item.local.name
							let path
							if (node.source) {
								path = resolveFileExtn(this.fileInfo.fileExtensionWithoutLeadingDot, this.fileInfo.directoryPath, node.source.value)
							} else {
								path = resolveFileExtn(this.fileInfo.fileExtensionWithoutLeadingDot, importedVariableSourceDict[name])
							}
							save(name, path)
						}
					})
				})

			codeTree.program.body.filter(node => node.type === 'ExportAllDeclaration')
				.forEach(node => {
					const path = resolveFileExtn(this.fileInfo.fileExtensionWithoutLeadingDot, this.fileInfo.directoryPath, node.source.value)
					this.getExportedVariables(path, plugins).forEach(name => {
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

const resolveFileExtn = _.memoize((extn: string, ...path: string[]) => {
	const filePath = fp.resolve(...path)

	if (fs.existsSync(filePath)) {
		return filePath
	}

	return filePath + '.' + extn
}, (...args: string[]) => args.join('|'))
