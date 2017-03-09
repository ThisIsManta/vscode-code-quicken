// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { Minimatch } from 'minimatch'

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<{ path: string, code: string | string[], temp: (object) => string }>
    const nodePatterns = config.get('nodes', []) as Array<{ name: string, code: string | string[], temp: (object) => string, exec: (string) => boolean }>
    const insertAtTheTopMost = config.get('insertAtTheTopMost') as boolean

    filePatterns.forEach(pattern => {
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })
    nodePatterns.forEach(pattern => {
        const matcher = new Minimatch(pattern.name)
        pattern.exec = matcher.match.bind(matcher)
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })

    const WIN_SLASH = /\\/g
    const ROOT_PATH = new RegExp('^' + _.escapeRegExp(vscode.workspace.rootPath))

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

    let disposable = vscode.commands.registerCommand('extension.haste', async () => {
        const currentDocument = vscode.window.activeTextEditor.document
        const currentFilePath = currentDocument.fileName

        const items = []

        // currentDocument.getText()
        nodeModules.forEach(nodeModule => {
            items.push({
                label: nodeModule.name,
                description: nodeModule.vers,
                type: 'node',
                name: nodeModule.name,
                temp: nodeModule.temp,
            })
        })

        for (let index = 0; index < filePatterns.length; index++) {
            const pattern = filePatterns[index]
            const files = await vscode.workspace.findFiles(pattern.path, null, 2000)

            files.forEach(file => {
                if (file.fsPath !== currentFilePath) {
                    items.push({
                        label: path.basename(file.path),
                        description: file.fsPath.replace(ROOT_PATH, '').replace(WIN_SLASH, '/'),
                        type: 'file',
                        path: file.fsPath,
                        temp: pattern.temp,
                    })
                }
            })
        }

        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return null
        }

        const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })
        if (!select) {
            return null
        }

        let code: string
        if (select.type === 'node') {
            code = select.temp({
                _, // Lodash
                nodeName: select.name,
            })

        } else if (select.type === 'file') {
            let selectRelativePath = path.relative(path.dirname(currentFilePath), select.path).replace(WIN_SLASH, '/')
            if (selectRelativePath.startsWith('../') === false) {
                selectRelativePath = './' + selectRelativePath
            }

            const extension = path.extname(select.path)
            const selectFileNameWithoutExtension = _.camelCase(path.basename(select.path).replace(new RegExp(_.escapeRegExp(extension) + '$'), ''))

            code = select.temp({
                _, // Lodash
                fullPath: select.path,
                filePath: selectRelativePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: extension,
            })
        }

        editor.edit(builder => {
            builder.insert(insertAtTheTopMost ? new vscode.Position(0, 0) : editor.selection.active, code);
        })
    })

    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.')
    })

    context.subscriptions.push(disposable)
}

export function deactivate() {
}