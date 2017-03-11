/// <reference types="babel-types" />

import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match } from 'minimatch'
import * as babylon from 'babylon'

const WIN_SLASH = /\\/g
const CURRENT_DIRX = /^\.\//

const fileCache = new Map<string, object>()
const nodeCache = new Map<string, object>()

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<{
        path: string | Array<string>,
        code: string | string[],
        when?: string,
        matchPath: (string) => boolean,
        matchCondition: (object) => boolean,
        interpolate: (object) => string,
        omitExtensionInFilePath: boolean | string,
        insertAt: string,
        inclusion: Array<string>,
        exclusion: Array<string>,
    }>
    const nodePatterns = config.get('nodes', []) as Array<{
        name: string,
        code: string | string[],
        when?: string,
        matchName: (string) => boolean,
        interpolate: (object) => string,
        insertAt: string,
    }>
    const insertAt = config.get('insertAt') as string
    const parsingPlugins = config.get('javascript.parser.plugins') as Array<string>

    filePatterns.forEach(pattern => {
        const multiPaths = typeof pattern.path === 'string' ? [pattern.path as string] : (pattern.path as Array<string>)
        pattern.inclusion = multiPaths.filter(item => item.startsWith('!') === false)
        pattern.exclusion = _.difference(multiPaths, pattern.inclusion).map(item => _.trimStart(item, '!'))

        pattern.matchPath = (givenPath: string) => {
            const matcher = (glob) => match([givenPath], glob).length > 0
            return pattern.inclusion.some(matcher) && !pattern.exclusion.some(matcher)
        }

        pattern.matchCondition = ({ currentRootPath, currentFilePath, currentFileNameWithoutExtn, currentFileExtension }) => {
            if (pattern.when) {
                try {
                    return _.template('${' + pattern.when + '}')({
                        rootPath: currentRootPath.replace(WIN_SLASH, '/'),
                        filePath: currentFilePath.replace(WIN_SLASH, '/'),
                        fileName: currentFileNameWithoutExtn,
                        fileExtn: currentFileExtension,
                        // codeTree: currentCodeTree,
                        // findInCodeTree: (target) => findInCodeTree(currentCodeTree, target),
                    }) === 'true'
                } catch (ex) {
                    console.error(ex)
                    return false
                }
            }
            return true
        }

        pattern.interpolate = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })
    nodePatterns.forEach(pattern => {
        pattern.matchName = (givenPath: string) => match([givenPath], pattern.name).length > 0

        pattern.interpolate = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })

    let disposable = vscode.commands.registerCommand('haste', async () => {
        const currentDocument = vscode.window.activeTextEditor.document
        const currentRootPath = vscode.workspace.rootPath
        const currentFilePath = currentDocument.fileName
        const currentFileExtension = path.extname(currentFilePath).replace(/^\./, '')
        const currentFileNameWithoutExtn = path.basename(currentFilePath).replace(new RegExp('\\.' + currentFileExtension + '$', 'i'), '')
        const currentFileDirx = path.dirname(currentFilePath)

        let items = []

        const applicableFilePatterns = filePatterns.filter(pattern => pattern.matchCondition({ currentRootPath, currentFilePath, currentFileNameWithoutExtn, currentFileExtension }))
        for (let index = 0; index < applicableFilePatterns.length; index++) {
            const pattern = applicableFilePatterns[index]
            const files = await vscode.workspace.findFiles(
                pattern.inclusion.length === 1 ? pattern.inclusion[0] : ('{' + pattern.inclusion.join(',') + '}'),
                pattern.exclusion.length === 0 ? null : (pattern.exclusion.length === 1 ? pattern.exclusion[0] : ('{' + pattern.exclusion.join(',') + '}')),
                9000
            )
            _.chain(files)
                .map(fileInfo => {
                    if (fileCache.has(fileInfo.fsPath) === false) {
                        const fileName = path.basename(fileInfo.path)
                        const directoryName = _.last(path.dirname(fileInfo.path).split('/'))
                        fileCache.set(fileInfo.fsPath, {
                            label: fileName === 'index.js' && directoryName || fileName,
                            description: _.trimStart(fileInfo.fsPath.substring(currentRootPath.length).replace(WIN_SLASH, '/'), '/'),
                            type: 'file',
                            path: fileInfo.fsPath,
                            unix: fileInfo.path,
                        })
                    }
                    return fileCache.get(fileInfo.fsPath)
                })
                .sortBy((item: any) => getRelativePath(item.path, currentFileDirx).replace(CURRENT_DIRX, '*'))
                .forEach((item: any) => {
                    if (item.path !== currentFilePath) {
                        items.push(item)
                    }
                })
                .value()
        }

        if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
            const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'))
            _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
                .flatten<string>()
                .map(nodeName => {
                    if (nodeCache.has(nodeName) === false) {
                        let nodeVersion = ''
                        try {
                            const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'))
                            if (packageJson.version) {
                                nodeVersion = packageJson.version
                            }
                        } catch (ex) { }

                        const pattern = nodePatterns.find(pattern => pattern.matchName(nodeName))
                        if (pattern) {
                            nodeCache.set(nodeName, {
                                label: nodeName,
                                description: nodeVersion,
                                type: 'node',
                                name: nodeName,
                            })
                        } else {
                            return null
                        }
                    }
                    return nodeCache.get(nodeName)
                })
                .compact()
                .sortBy('name')
                .forEach(item => {
                    items.push(item)
                })
                .value()
        }

        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return null
        }

        const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })
        if (!select) {
            return null
        }

        const currentCodeTree = /(js|ts)/.test(currentFileExtension) ? getCodeTree(currentDocument.getText(), parsingPlugins) : null
        let existingImportItems = []
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportItems = currentCodeTree.program.body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        }

        let code = ''
        let insertAt: string
        if (select.type === 'node') {
            const pattern = nodePatterns.find(pattern => pattern.matchName(select.name))

            insertAt = pattern.insertAt

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                nodeName: select.name,
            })

        } else if (select.type === 'file') {
            const selectFileExtension = path.extname(select.path).replace(/^\./, '')
            const selectFileNameWithExtension = path.basename(select.path)
            const selectFileNameWithoutExtension = selectFileNameWithExtension.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '')
            const selectCodeText = fs.readFileSync(select.path, 'utf-8')
            const selectCodeTree = /(js|ts)/.test(currentFileExtension) ? getCodeTree(selectCodeText, parsingPlugins) : null

            const pattern = filePatterns.find(pattern =>
                pattern.matchPath(_.trimStart(select.path.substring(currentRootPath.length).replace(WIN_SLASH, '/'), '/')) &&
                pattern.matchCondition({ currentRootPath, currentFilePath, currentFileNameWithoutExtn, currentFileExtension, })
            )

            insertAt = pattern.insertAt

            let selectRelativeFilePath = getRelativePath(select.path, currentFileDirx)
            if (selectFileNameWithExtension === 'index.js') {
                selectRelativeFilePath = _.trimEnd(selectRelativeFilePath.substring(0, selectRelativeFilePath.length - selectFileNameWithExtension.length), '/')
            } else if (pattern.omitExtensionInFilePath === true || typeof pattern.omitExtensionInFilePath === 'string' && pattern.omitExtensionInFilePath.toString().length > 0 && new RegExp(pattern.omitExtensionInFilePath, 'i').test(selectFileExtension)) {
                selectRelativeFilePath = selectRelativeFilePath.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '')
            }

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                fullPath: select.unix,
                filePath: selectRelativeFilePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: selectFileExtension,
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasExportDefault: selectCodeTree === null || findInCodeTree(selectCodeTree, { type: 'ExportDefaultDeclaration' }) !== undefined,
                findInCodeTree: (target) => findInCodeTree(getCodeTree, target),
            })
        }

        editor.edit(worker => {
            let position: vscode.Position
            if (insertAt === 'beforeFirstImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.first(existingImportItems).loc.start.line - 1, _.first(existingImportItems).loc.start.column)

            } else if (insertAt === 'beforeFirstImport' && existingImportItems.length === 0 || insertAt === 'top') {
                position = new vscode.Position(0, 0)

            } else if (insertAt === 'afterLastImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.last(existingImportItems).loc.end.line, 0)

            } else if (insertAt === 'afterLastImport' && existingImportItems.length === 0 || insertAt === 'bottom') {
                position = new vscode.Position(currentDocument.getText().replace(/\r/g, '').split('\n').length + 1, 0)

            } else {
                position = editor.selection.active
            }

            worker.insert(position, code);
        })
    })

    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.')
    })

    context.subscriptions.push(disposable)
}

export function deactivate() {
    fileCache.clear()
    nodeCache.clear()
}

function getRelativePath(givenPath, rootPath) {
    let relativePath = path.relative(rootPath, givenPath).replace(WIN_SLASH, '/')
    if (relativePath.startsWith('../') === false) {
        relativePath = './' + relativePath
    }
    return relativePath
}

function getCodeTree(text, plugins = []): any {
    try {
        return babylon.parse(text, {
            sourceType: 'module',
            plugins: [...plugins]
        })
    } catch (ex) {
        console.error(ex)
        return null
    }
}

function findInCodeTree(branch: object, target: object) {
    if (branch === null) {
        return undefined

    } else if (_.isMatch(branch, target)) {
        return target

    } else if (_.isArrayLike(branch['body'])) {
        for (let index = 0; index < branch['body'].length; index++) {
            const result = findInCodeTree(branch['body'][index], target)
            if (result !== undefined) {
                return result
            }
        }
        return undefined

    } else if (_.isObject(branch['body'])) {
        return findInCodeTree(branch['body'], target)

    } else {
        return undefined
    }
}
