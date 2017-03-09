// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { Minimatch } from 'minimatch'
import * as espree from 'espree'

const WIN_SLASH = /\\/g

const fileCache = new Map<string, object>()
let nodeCache = []

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<{ path: string, code: string | string[], temp: (object) => string }>
    const nodePatterns = config.get('nodes', []) as Array<{ name: string, code: string | string[], temp: (object) => string, exec: (string) => boolean }>
    const insertAt = config.get('insertAt') as string
    const parsingOptions = config.get('javascriptParsingOptions') as object

    filePatterns.forEach(pattern => {
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })
    nodePatterns.forEach(pattern => {
        const matcher = new Minimatch(pattern.name)
        pattern.exec = matcher.match.bind(matcher)
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
        const currentFilePath = currentDocument.fileName
        const currentFileDirx = path.dirname(currentFilePath)

        let items = []

        for (let index = 0; index < filePatterns.length; index++) {
            const pattern = filePatterns[index]
            const files = await vscode.workspace.findFiles(pattern.path, null, 9000)
            const CURRENT_DIRX = /^\.\//

            _.chain(files)
                .map(file => {
                    if (fileCache.has(file.fsPath) === false) {
                        fileCache.set(file.fsPath, {
                            label: path.basename(file.path),
                            description: _.trimStart(file.fsPath.replace(vscode.workspace.rootPath, '').replace(WIN_SLASH, '/'), '/'),
                            type: 'file',
                            path: file.fsPath,
                            temp: pattern.temp,
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

        const currentCodeTree = getCodeTree(currentDocument.getText(), parsingOptions)
        let existingImportItems = []
        if (currentCodeTree && currentCodeTree.body) {
            existingImportItems = currentCodeTree.body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        }

        let code = ''
        if (select.type === 'node') {
            if (existingImportItems.find((line: any) => line.source.value === select.name)) {
                vscode.window.showErrorMessage(`Importing '${select.name}' already exists.`)
                return null
            }

            code = select.temp({
                _, // Lodash
                nodeName: select.name,
            })

        } else if (select.type === 'file') {
            const selectRelativePath = getRelativePath(currentFileDirx, select.path)

            if (existingImportItems.find((line: any) => line.source.value === selectRelativePath)) {
                vscode.window.showErrorMessage(`Importing '${selectRelativePath}' already exists.`)
                return null
            }

            const extension = path.extname(select.path)
            const selectFileNameWithoutExtension = _.camelCase(path.basename(select.path).replace(new RegExp(_.escapeRegExp(extension) + '$'), ''))
            const selectCodeText = fs.readFileSync(select.path, 'utf-8')
            const selectCodeTree = getCodeTree(selectCodeText, parsingOptions)
            
            code = select.temp({
                _, // Lodash
                fullPath: select.path,
                filePath: selectRelativePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: extension.replace(/^\./, ''),
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasExportDefault: /*selectCodeTree === null ||*/ findInCodeTree(selectCodeTree, { type: 'ExportDefaultDeclaration' }) !== undefined,
                findInCodeTree,
            })
        }

        editor.edit(worker => {
            let position = editor.selection.active
            if (insertAt === 'beforeFirstImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.first(existingImportItems).loc.start.line - 1, _.first(existingImportItems).loc.start.column)
                } else {
                    position = new vscode.Position(0, 0)
                }

            } else if (insertAt === 'afterLastImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.last(existingImportItems).loc.end.line, 0)
                } else {
                    position = new vscode.Position(0, 0)
                }
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

function getCodeTree(text, options = {}) {
    try {
        return espree.parse(text, {
            ...options,
            sourceType: 'module',
            range: true,
            loc: true,
            comment: false,
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
