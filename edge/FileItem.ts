import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import FileInfo from './FileInfo'
import FilePattern from './FilePattern'

export default class FileItem implements vscode.QuickPickItem {
	label: string
	description: string
	path: string
	unix: string
	dirx: string
	rank: string
	iden: string

	constructor(pattern: FilePattern, fileLink: vscode.Uri) {
		const fileInfo = new FileInfo(fileLink.fsPath)

		this.label = pattern.omitIndexFile && fileInfo.fileNameWithoutExtension === 'index' && fileInfo.directoryName || fileInfo.fileNameWithExtension
		this.description = _.trim(path.dirname(fileLink.fsPath.substring(vscode.workspace.rootPath.length)), path.sep)

		this.path = fileInfo.localPath
		this.unix = fileInfo.unixPath
		this.dirx = path.dirname(fileLink.fsPath)
		this.iden = fileInfo.fileNameWithoutExtension === 'index' ? '!' : fileInfo.fileNameWithExtension.toLowerCase()
	}

	updateRank(currentDirectoryPath: string) {
		if (vscode.workspace.textDocuments.find(document => document.fileName === this.path) !== undefined) {
			this.rank = 'a'
		} else if (this.dirx === currentDirectoryPath) {
			this.rank = 'b'
		} else {
			this.rank = FileInfo.getRelativePath(this.path, currentDirectoryPath).split('/').map((chunk, index, array) => {
				if (chunk === '.') return 'c'
				else if (chunk === '..') return 'f'
				else if (index === array.length - 1 && index > 0 && array[index - 1] === '..') return 'd'
				else if (index === array.length - 1) return 'z'
				return 'e'
			}).join('')
		}
	}
}
