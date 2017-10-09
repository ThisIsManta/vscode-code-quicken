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
						return this.getExportedVariables(fp.resolve(filePath, node.source.value), plugins)
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

			const exportStatements = codeTree.program.body.filter(node => node.type === 'ExportNamedDeclaration')
			const exportedVariableList = new Array<string>()
			const exportedVariableSourceDict = new Map<string, string>()
			const sourceExportedVariableDict = new Map<string, Array<string>>()
			exportStatements.forEach(node => {
				node.specifiers.forEach(item => {
					if (item => item.type === 'ExportSpecifier' && item.local && item.local.type === 'Identifier') {
						const name = item.local.name
						let path
						if (node.source) {
							path = fp.resolve(this.fileInfo.directoryPath, node.source.value)
						} else {
							path = importedVariableSourceDict[name]
						}

						if (path) {
							exportedVariableList.push(name)
							exportedVariableSourceDict.set(name, path)
							if (sourceExportedVariableDict.has(path)) {
								sourceExportedVariableDict.get(path).push(name)
							} else {
								sourceExportedVariableDict.set(path, [name])
							}
						}
					}
				})
			})

			if (this.fileInfo.fileNameWithoutExtension === 'index') {
				return exportedVariableList
			}

			if (sourceExportedVariableDict.has(this.fileInfo.fullPath)) {
				return sourceExportedVariableDict.get(this.fileInfo.fullPath)
			}

			const pathWithoutExtn = this.fileInfo.fullPath.replace(new RegExp('\\.' + this.fileInfo.fileExtensionWithoutLeadingDot + '$'), '')
			if (sourceExportedVariableDict.has(pathWithoutExtn)) {
				return sourceExportedVariableDict.get(pathWithoutExtn)
			}

		} catch (ex) {
			console.error(ex)
		}

		return []
	}
}
