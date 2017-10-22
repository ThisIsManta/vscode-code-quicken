import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import { Parser, nodes as Nodes } from 'stylus'

import { RootConfigurations, Language, Item, getSortablePath } from './global';
import FileInfo from './FileInfo'

export interface LanguageOptions {
	preferImports: boolean
	omitStylusFileExtensionFromPath: boolean
	omitIndexStylusFileNameFromPath: boolean
	preferSingleQuotes: boolean
	removeSemiColons: boolean
}

export default class Stylus implements Language {
	private baseConfig: RootConfigurations
	private fileItemCache: Array<FileItem>

	constructor(baseConfig: RootConfigurations) {
		this.baseConfig = baseConfig
	}

	async getItems(document: vscode.TextDocument) {
		if (SUPPORTED_LANGUAGE.test(document.languageId) === false) {
			return null
		}

		const documentFileInfo = new FileInfo(document.fileName)

		if (!this.fileItemCache) {
			const fileLinks = await vscode.workspace.findFiles('**/*.{styl,css,jpg,jpeg,png,gif,svg,otf,ttf,woff,woff2,eot}')

			this.fileItemCache = fileLinks
				.map(fileLink => new FileItem(new FileInfo(fileLink.fsPath), this.baseConfig.stylus))
		}

		const items = _.chain(this.fileItemCache)
			.reject(item => item.fileInfo.fullPath === documentFileInfo.fullPath) // Remove the current file
			.forEach(item => item.sortablePath = getSortablePath(item.fileInfo, documentFileInfo))
			.sortBy([ // Sort files by their path and name
				item => item.sortablePath,
				item => item.sortableName,
			])
			.value()

		return items
	}

	addItem(filePath: string) {
		if (this.fileItemCache) {
			const fileInfo = new FileInfo(filePath)
			this.fileItemCache.push(new FileItem(fileInfo, this.baseConfig.stylus))
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

	reset() {
		this.fileItemCache = null
	}

	static parse(code: string) {
		try {
			return (new Parser(code) as any).parse()

		} catch (ex) {
			console.error(ex)
			return null
		}
	}
}

class FileItem implements Item {
	private options: LanguageOptions
	readonly id: string;
	readonly label: string;
	readonly description: string;
	fileInfo: FileInfo
	sortableName: string
	sortablePath: string

	constructor(fileInfo: FileInfo, options: LanguageOptions) {
		this.id = fileInfo.fullPathForPOSIX
		this.options = options
		this.fileInfo = fileInfo

		this.description = _.trim(fp.dirname(this.fileInfo.fullPath.substring(vscode.workspace.rootPath.length)), fp.sep)

		if (this.options.omitIndexStylusFileNameFromPath && this.fileInfo.fileNameWithExtension === 'index.styl') {
			this.label = this.fileInfo.directoryName
			this.description = _.trim(this.fileInfo.fullPath.substring(vscode.workspace.rootPath.length), fp.sep)
		} else if (this.options.omitStylusFileExtensionFromPath && this.fileInfo.fileExtensionWithoutLeadingDot === 'styl') {
			this.label = this.fileInfo.fileNameWithoutExtension
		} else {
			this.label = this.fileInfo.fileNameWithExtension
		}

		if (this.fileInfo.fileNameWithExtension === 'index.styl') {
			this.sortableName = '!'
		} else {
			this.sortableName = this.fileInfo.fileNameWithExtension.toLowerCase()
		}
	}

	async addImport(document: vscode.TextDocument) {
		const directoryPathOfWorkingDocument = new FileInfo(document.fileName).directoryPath

		const quote = this.options.preferSingleQuotes ? '\'' : '"'

		if (/^(styl|css)$/.test(this.fileInfo.fileExtensionWithoutLeadingDot)) {
			let path = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument)

			if (this.options.omitIndexStylusFileNameFromPath && this.fileInfo.fileNameWithExtension === 'index.styl') {
				path = fp.dirname(path)

			} else if (this.options.omitStylusFileExtensionFromPath && this.fileInfo.fileExtensionWithoutLeadingDot === 'styl') {
				path = path.replace(/\.styl$/, '')
			}

			let position = new vscode.Position(0, 0)
			const codeTree = Stylus.parse(document.getText())
			if (codeTree) {
				const firstImport = codeTree.nodes.find(node => node instanceof Nodes.Import)
				if (firstImport) {
					position = new vscode.Position(firstImport.lineno - 1, 0)
				}
			}

			const snippet = `@${this.options.preferImports ? 'import' : 'require'} ${quote}${path}${quote}${this.options.removeSemiColons ? '' : ';'}${document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'}`

			return (worker: vscode.TextEditorEdit) => worker.insert(position, snippet)

		} else {
			const path = this.fileInfo.getRelativePath(directoryPathOfWorkingDocument)

			let snippet = `url(${quote}${path}${quote})`

			const position = vscode.window.activeTextEditor.selection.active
			if (position.character > 1 && /\w/.test(document.getText(new vscode.Range(position.translate(0, -1), position)))) {
				snippet = ' ' + snippet
			}

			return (worker: vscode.TextEditorEdit) => worker.insert(vscode.window.activeTextEditor.selection.active, snippet)
		}
	}
}

const SUPPORTED_LANGUAGE = /^stylus$/