"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const _ = require("lodash");
const minimatch_1 = require("minimatch");
class NodePattern {
    get insertAt() {
        return this.config.insertAt;
    }
    constructor(config) {
        this.config = config;
        this.interpolate = _.template(_.isArray(config.code) ? config.code.join('\n') : config.code);
    }
    match(givenPath) {
        return minimatch_1.match([givenPath], this.config.name).length > 0;
    }
}
exports.default = NodePattern;
//# sourceMappingURL=NodePattern.js.map