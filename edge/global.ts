import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import FileInfo from './FileInfo'
import * as JavaScript from './JavaScript'
import * as Stylus from './Stylus'

export interface Configurations {
	history: number
	javascript: JavaScript.LanguageOptions
	typescript: JavaScript.LanguageOptions
	stylus: Stylus.LanguageOptions
}

export interface Language {
	getItems(document: vscode.TextDocument): Promise<{ shortItems: Array<Item>; totalItems: Array<Item> } | null>
	addItem?(filePath: string): void
	cutItem?(filePath: string): void
	fixImport?(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken): Promise<boolean | null>
	convertImport?(editor: vscode.TextEditor): Promise<boolean | null>
	reset(): void
}

export interface Item extends vscode.QuickPickItem {
	id: string
	addImport(editor: vscode.TextEditor): Promise<null | undefined>
}

export function getSortingLogic<T extends { fileInfo: FileInfo }>(rootPath: string) {
	return [
		(item: T) => item.fileInfo.directoryPath === rootPath
			? '!'
			: item.fileInfo.directoryPath.substring(rootPath.length).toLowerCase(),
		(item: T) => item.fileInfo.fileNameWithoutExtension === 'index' ? 1 : 0,
		(item: T) => /^\W*[a-z]/.test(item.fileInfo.fileNameWithExtension)
			? item.fileInfo.fileNameWithExtension.toUpperCase()
			: item.fileInfo.fileNameWithExtension.toLowerCase()
	]
}

export function getShortList<T extends { fileInfo: FileInfo }>(items: Array<T>, documentFileInfo: FileInfo) {
	const documentFileWords = _.words(documentFileInfo.fileNameWithoutExtension)

	const itemsFromCurrentDirectory = _.chain(items)
		.filter(item => item.fileInfo.directoryPath === documentFileInfo.directoryPath)
		.sortBy(item => {
			const fileWords = _.words(item.fileInfo.fileNameWithoutExtension)
			return documentFileWords.length - _.intersection(documentFileWords, fileWords).length
		})
		.value()

	const itemsFromSubDirectories = items
		.filter(item => item.fileInfo.directoryPath.startsWith(documentFileInfo.directoryPath + fp.sep))

	return itemsFromCurrentDirectory.concat(itemsFromSubDirectories)
}

export async function findFilesRoughly(filePath: string, fileExtension?: string) {
	const fileName = fp.basename(filePath)

	let fileLinks = await vscode.workspace.findFiles('**/' + fileName)
	if (fileExtension && fileName.endsWith('.' + fileExtension) === false) {
		fileLinks = fileLinks.concat(await vscode.workspace.findFiles('**/' + fileName + '.' + fileExtension))
		fileLinks = fileLinks.concat(await vscode.workspace.findFiles('**/' + fileName + '/index.' + fileExtension))
	}

	const matchingPaths = fileLinks.map(item => item.fsPath)

	if (matchingPaths.length > 1) {
		// Given originalPath = '../../../abc/xyz.js'
		// Set originalPathList = ['abc', 'xyz.js']
		const originalPathList = filePath.split(/\\|\//).slice(0, -1).filter(pathUnit => pathUnit !== '.' && pathUnit !== '..')

		let count = 0
		while (++count <= originalPathList.length) {
			const refinedPaths = matchingPaths.filter(path => path.split(/\\|\//).slice(0, -1).slice(-count).join('|') === originalPathList.slice(-count).join('|'))
			if (refinedPaths.length === 1) {
				return refinedPaths
			}
		}
	}

	return matchingPaths
}
