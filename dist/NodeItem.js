"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const path = require("path");
class NodeItem {
    constructor(nodeName) {
        this.description = '';
        this.version = '';
        this.label = nodeName;
        this.name = nodeName;
        try {
            const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'));
            if (packageJson.version) {
                this.description = 'v' + packageJson.version;
                this.version = packageJson.version;
            }
        }
        catch (ex) { }
    }
}
exports.default = NodeItem;
//# sourceMappingURL=NodeItem.js.map