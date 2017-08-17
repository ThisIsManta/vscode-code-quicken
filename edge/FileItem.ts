import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import FileInfo from './FileInfo'

export default class FileItem implements vscode.QuickPickItem {
	readonly label: string
	readonly description: string
	readonly fileInfo: FileInfo
	sortablePath: string
	readonly sortableName: string

	constructor(fileLink: vscode.Uri) {
		this.fileInfo = new FileInfo(fileLink.fsPath)

		this.label = this.fileInfo.fileNameWithoutExtension === 'index' && this.fileInfo.directoryName || this.fileInfo.fileNameWithExtension
		this.description = _.trim(path.dirname(fileLink.fsPath.substring(vscode.workspace.rootPath.length)), path.sep)

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
}
