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
let nodeCache = []

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<{
        path: string | Array<string>,
        code: string | string[],
        when?: string,
        isMatch: (string) => boolean,
        interpolate: (object) => string,
        omitExtensionInFilePath: boolean | string,
        insertAt: string,
        inclusion: Array<string>,
        exclusion: Array<string>
    }>
    const nodePatterns = config.get('nodes', []) as Array<{
        name: string,
        code: string | string[],
        when?: string,
        exec: (string) => boolean,
        temp: (object) => string,
        insertAt: string
    }>
    const insertAt = config.get('insertAt') as string
    const parsingPlugins = config.get('javascript.parser.plugins') as Array<string>

    filePatterns.forEach(pattern => {
        const multiPaths = typeof pattern.path === 'string' ? [pattern.path as string] : (pattern.path as Array<string>)
        pattern.inclusion = multiPaths.filter(item => item.startsWith('!') === false)
        pattern.exclusion = _.difference(multiPaths, pattern.inclusion).map(item => _.trimStart(item, '!'))
        pattern.isMatch = (givenPath: string) => {
            const matcher = (glob) => match([givenPath], glob).length > 0
            return pattern.inclusion.some(matcher) && !pattern.exclusion.some(matcher)
        }
        pattern.interpolate = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })
    nodePatterns.forEach(pattern => {
        pattern.exec = (givenPath: string) => match([givenPath], pattern.name).length > 0
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })

    if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
        const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'))
        nodeCache = _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
            .flatten<string>()
            .sortBy()
            .map(nodeName => {
                try {
                    const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'))
                    if (packageJson.version) {
                        return { name: nodeName, vers: packageJson.version as string }
                    } else {
                        return null
                    }
                } catch (ex) {
                    return null
                }
            })
            .compact()
            .map(nodeModule => {
                const pattern = nodePatterns.find(pattern => pattern.exec(nodeModule.name))
                if (pattern) {
                    return { ...nodeModule, temp: pattern.temp }
                } else {
                    return null
                }
            })
            .compact()
            .map(nodeModule => ({
                label: nodeModule.name,
                description: nodeModule.vers,
                type: 'node',
                name: nodeModule.name,
                temp: nodeModule.temp,
            }))
            .value()
    }

    let disposable = vscode.commands.registerCommand('haste', async () => {
        const currentDocument = vscode.window.activeTextEditor.document
        const currentRootPath = vscode.workspace.rootPath

        const currentFilePath = currentDocument.fileName
        const currentFileExtn = path.extname(currentFilePath).replace(/^\./, '')
        const currentFileNameWithoutExtn = path.basename(currentFilePath).replace(new RegExp('\\.' + currentFileExtn + '$', 'i'), '')
        const currentFileDirx = path.dirname(currentFilePath)

        let items = []

        const distinctFilePatterns = _.uniqBy(filePatterns, 'path')
        for (let index = 0; index < distinctFilePatterns.length; index++) {
            const pattern = distinctFilePatterns[index]
            const files = await vscode.workspace.findFiles(
                pattern.inclusion.length === 1 ? pattern.inclusion[0] : ('{' + pattern.inclusion.join(',') + '}'),
                pattern.exclusion.length === 0 ? null : (pattern.exclusion.length === 1 ? pattern.exclusion[0] : ('{' + pattern.exclusion.join(',') + '}')),
                9000
            )
            _.chain(files)
                .map(file => {
                    if (fileCache.has(file.fsPath) === false) {
                        fileCache.set(file.fsPath, {
                            label: path.basename(file.path),
                            description: _.trimStart(file.fsPath.replace(currentRootPath, '').replace(WIN_SLASH, '/'), '/'),
                            type: 'file',
                            path: file.fsPath,
                        })
                    }
                    return fileCache.get(file.fsPath)
                })
                .sortBy((item: any) => getRelativePath(currentFileDirx, item.path).replace(CURRENT_DIRX, '*'))
                .forEach((item: any) => {
                    if (item.path !== currentFilePath) {
                        items.push(item)
                    }
                })
                .value()
        }

        items = items.concat(nodeCache)

        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return null
        }

        const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })
        if (!select) {
            return null
        }

        const currentCodeTree = /(js|ts)/.test(currentFileExtn) ? getCodeTree(currentDocument.getText(), parsingPlugins) : null
        let existingImportItems = []
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportItems = currentCodeTree.program.body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        }

        let code = ''
        let insertAt: string
        if (select.type === 'node') {
            const pattern = nodePatterns.find(pattern => pattern.exec(select.name))

            insertAt = pattern.insertAt

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`)
                return null
            }

            code = pattern.temp({
                _, // Lodash
                nodeName: select.name,
            })

        } else if (select.type === 'file') {
            const selectFileExtn = path.extname(select.path).replace(/^\./, '')
            const selectFileNameWithoutExtn = path.basename(select.path).replace(new RegExp('\\.' + selectFileExtn + '$', 'i'), '')
            const selectCodeText = fs.readFileSync(select.path, 'utf-8')
            const selectCodeTree = /(js|ts)/.test(currentFileExtn) ? getCodeTree(selectCodeText, parsingPlugins) : null

            const pattern = filePatterns.find(pattern => {
                if (pattern.isMatch(_.trimStart(select.path.substring(currentRootPath.length).replace(WIN_SLASH, '/'), '/'))) {
                    if (pattern.when) {
                        try {
                            return _.template('${' + pattern.when + '}')({
                                rootPath: currentRootPath,
                                filePath: currentFilePath,
                                fileName: currentFileNameWithoutExtn,
                                fileExtn: currentFileExtn,
                                codeTree: currentCodeTree,
                                findInCodeTree: (target) => findInCodeTree(getCodeTree, target),
                            }) === 'true'
                        } catch (ex) {
                            console.error(ex)
                            return false
                        }
                    } else {
                        return true
                    }
                }
                return false
            })

            insertAt = pattern.insertAt

            let selectRelativePath = getRelativePath(currentFileDirx, select.path)
            if (pattern.omitExtensionInFilePath === true || typeof pattern.omitExtensionInFilePath === 'string' && pattern.omitExtensionInFilePath.toString().length > 0 && new RegExp(pattern.omitExtensionInFilePath, 'i').test(selectFileExtn)) {
                selectRelativePath = selectRelativePath.replace(new RegExp('\\.' + selectFileExtn + '$', 'i'), '')
            }

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === selectRelativePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativePath}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                fullPath: select.path,
                filePath: selectRelativePath,
                fileName: selectFileNameWithoutExtn,
                fileExtn: selectFileExtn,
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
    nodeCache = []
}

function getRelativePath(currentPath, anotherPath) {
    let relativePath = path.relative(currentPath, anotherPath).replace(WIN_SLASH, '/')
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
