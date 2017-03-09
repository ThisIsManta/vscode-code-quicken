// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { Minimatch } from 'minimatch'
import * as espree from 'espree'

const WIN_SLASH = /\\/g

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<{ path: string, code: string | string[], temp: (object) => string }>
    const nodePatterns = config.get('nodes', []) as Array<{ name: string, code: string | string[], temp: (object) => string, exec: (string) => boolean }>
    const insertAt = config.get('insertAt') as string

    filePatterns.forEach(pattern => {
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })
    nodePatterns.forEach(pattern => {
        const matcher = new Minimatch(pattern.name)
        pattern.exec = matcher.match.bind(matcher)
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })

    let nodeModules: Array<{ name: string, vers: string, temp?: (object) => string }> = []
    if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
        const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'))
        nodeModules = _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
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
            .value()
    }

    let disposable = vscode.commands.registerCommand('haste', async () => {
        const currentDocument = vscode.window.activeTextEditor.document
        const currentFilePath = currentDocument.fileName
        const currentFileDirx = path.dirname(currentFilePath)

        let items = []

        const cache = new Map<string, vscode.Uri>()
        for (let index = 0; index < filePatterns.length; index++) {
            const pattern = filePatterns[index]
            const files = await vscode.workspace.findFiles(pattern.path, null, 9000)
            const CURRENT_DIRX = /^\.\//

            _.chain(files)
                .sortBy(file => getRelativePath(currentFileDirx, file.fsPath).replace(CURRENT_DIRX, '*'))
                .forEach(file => {
                    if (file.fsPath !== currentFilePath) {
                        items.push({
                            label: path.basename(file.path),
                            description: file.fsPath.replace(vscode.workspace.rootPath, '').replace(WIN_SLASH, '/'),
                            type: 'file',
                            path: file.fsPath,
                            temp: pattern.temp,
                        })
                    }
                })
                .value()
        }

        nodeModules.forEach(nodeModule => {
            items.push({
                label: nodeModule.name,
                description: nodeModule.vers,
                type: 'node',
                name: nodeModule.name,
                temp: nodeModule.temp,
            })
        })

        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return null
        }

        const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })
        if (!select) {
            return null
        }

        let existingImportItems: Array<any> = []
        try {
            existingImportItems = espree.parse(currentDocument.getText(), {
                range: true,
                loc: true,
                comment: false,
                sourceType: 'module',
                ecmaVersion: 6,
                ecmaFeatures: {
                    jsx: true,
                    impliedStrict: true,
                    experimentalObjectRestSpread: true,
                }
            }).body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        } catch (ex) {
            console.error(ex)
        }

        let code: string
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

            code = select.temp({
                _, // Lodash
                fullPath: select.path,
                filePath: selectRelativePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: extension.replace(/^\./, ''),
            })
        }

        editor.edit(builder => {
            let position = editor.selection.active

            if (insertAt === 'beforeFirstImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.first(existingImportItems).loc.start.line, _.first(existingImportItems).loc.start.column)
                } else {
                    position = new vscode.Position(0, 0)
                }
            } else if (insertAt === 'afterLastImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.last(existingImportItems).loc.start.line, _.last(existingImportItems).loc.start.column)
                } else {
                    position = new vscode.Position(0, 0)
                }
            }
            builder.insert(position, code);
        })
    })

    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.')
    })

    context.subscriptions.push(disposable)
}

export function deactivate() {
}

function getRelativePath(currentPath, anotherPath) {
    let relativePath = path.relative(currentPath, anotherPath).replace(WIN_SLASH, '/')
    if (relativePath.startsWith('../') === false) {
        relativePath = './' + relativePath
    }
    return relativePath
}