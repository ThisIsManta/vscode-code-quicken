import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'

export default class FilePattern implements vscode.Disposable {
	private config: FileConfiguration
	private readonly inclusionList: Array<string>
	private readonly exclusionList: Array<string>
	readonly interpolate: (object) => string
	private fileCache: Array<vscode.Uri> = null
	private fileWatch: vscode.FileSystemWatcher = null

	get checkForImportOrRequire() {
		return this.config.checkForImportOrRequire
	}

	get insertAt() {
		return this.config.insertAt
	}

	constructor(config: FileConfiguration) {
		this.config = config

		const multiPaths = typeof config.path === 'string' ? [config.path as string] : (config.path as Array<string>)
		this.inclusionList = multiPaths.filter(item => item.startsWith('!') === false)
		this.exclusionList = _.difference(multiPaths, this.inclusionList).map(item => _.trimStart(item, '!'))

		this.interpolate = Shared.createTemplate(config.code)
	}

	check(document: vscode.TextDocument): boolean {
		if (this.config.when) {
			try {
				const result = _.template('${' + this.config.when + '}')({
					_, // Lodash
					minimatch,
					path,
					activeDocument: document,
					activeFileInfo: new FileInfo(document.fileName),
				}) as string
				return !(result === 'false' || result === '' || parseFloat(result) === 0)
			} catch (ex) {
				console.error(ex)
				return false
			}
		}
		return true
	}

	match(fileInfo: FileInfo): boolean {
		let pathThatIsRelativeToRootPath = fileInfo.localPath
		if (pathThatIsRelativeToRootPath.startsWith(vscode.workspace.rootPath)) {
			pathThatIsRelativeToRootPath = _.trimStart(pathThatIsRelativeToRootPath.substring(vscode.workspace.rootPath.length).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'), '/')
		}

		const matcher = (glob) => minimatch([pathThatIsRelativeToRootPath], glob).length > 0
		return this.inclusionList.some(matcher) && !this.exclusionList.some(matcher)
	}

	getRelativeFilePath(fileInfo: FileInfo, currentDirectoryPath: string) {
		const relativeFilePath = fileInfo.getRelativePath(currentDirectoryPath)

		if (this.config.omitExtensionInSelectFilePath === true || typeof this.config.omitExtensionInSelectFilePath === 'string' && minimatch([fileInfo.fileExtensionWithoutLeadingDot], this.config.omitExtensionInSelectFilePath).length > 0) {
			return relativeFilePath.substring(0, relativeFilePath.length - 1 - fileInfo.fileExtensionWithoutLeadingDot.length)

		} else {
			return relativeFilePath
		}
	}

	async getFileLinks() {
		if (this.fileCache === null) {
			let inclusionPath: string
			if (this.inclusionList.length === 1) {
				inclusionPath = this.inclusionList[0]
			} else {
				inclusionPath = '{' + this.inclusionList.join(',') + '}'
			}

			let exclusionPath: string
			if (this.exclusionList.length === 1) {
				exclusionPath = this.exclusionList[0]
			} else if (this.exclusionList.length > 1) {
				exclusionPath = '{' + this.exclusionList.join(',') + '}'
			}

			this.fileCache = await vscode.workspace.findFiles(inclusionPath, exclusionPath)

			try {
				this.fileWatch = vscode.workspace.createFileSystemWatcher(path.join(vscode.workspace.rootPath, inclusionPath))
				this.fileWatch.onDidCreate(fileLink => {
					if (this.match(new FileInfo(fileLink.fsPath))) {
						this.fileCache.push(fileLink)
					}
				})
				this.fileWatch.onDidDelete(fileLink => {
					_.remove(this.fileCache, existingFileLink => existingFileLink.fsPath === fileLink.fsPath)
				})

			} catch (ex) {
				const temp = this.fileCache
				this.fileCache = null
				return temp
			}
		}
		return this.fileCache
	}

	dispose() {
		this.fileCache = null
		this.fileWatch.dispose()
	}
}
