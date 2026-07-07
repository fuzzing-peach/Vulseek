"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forEachOpenApiProcedure = exports.getMethod = exports.getInputOutputParsers = void 0;
const zod_1 = require("zod");
const mergeInputs = (inputParsers) => {
    return inputParsers.reduce((acc, inputParser) => {
        return acc.merge(inputParser);
    }, zod_1.z.object({}));
};
// `inputParser` & `outputParser` are private so this is a hack to access it
const getInputOutputParsers = (procedure) => {
    const { inputs, output } = procedure._def;
    return {
        inputParser: inputs.length >= 2 ? mergeInputs(inputs) : inputs[0],
        outputParser: output,
    };
};
exports.getInputOutputParsers = getInputOutputParsers;
const getProcedureType = (procedure) => {
    if (procedure._def.query)
        return "query";
    if (procedure._def.mutation)
        return "mutation";
    if (procedure._def.subscription)
        return "subscription";
    throw new Error("Unknown procedure type");
};
const getMethod = (procedure) => {
    return getProcedureType(procedure) === "query" ? "GET" : "POST";
};
exports.getMethod = getMethod;
const forEachOpenApiProcedure = (procedureRecord, callback) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    for (const [path, procedure] of Object.entries(procedureRecord)) {
        const additional = (_c = (_b = (_a = procedure._def.meta) === null || _a === void 0 ? void 0 : _a.openapi) === null || _b === void 0 ? void 0 : _b.additional) !== null && _c !== void 0 ? _c : false;
        const override = (_f = (_e = (_d = procedure._def.meta) === null || _d === void 0 ? void 0 : _d.openapi) === null || _e === void 0 ? void 0 : _e.override) !== null && _f !== void 0 ? _f : false;
        const defaultOpenApiMeta = {
            method: (0, exports.getMethod)(procedure),
            path: path,
            enabled: true,
            tags: [path.split(".")[0]],
            protect: true,
        };
        let openapi;
        if (override) {
            openapi = Object.assign({}, (_g = procedure._def.meta) === null || _g === void 0 ? void 0 : _g.openapi);
        }
        else if (additional) {
            openapi = Object.assign(Object.assign({}, defaultOpenApiMeta), (_h = procedure._def.meta) === null || _h === void 0 ? void 0 : _h.openapi);
        }
        else {
            openapi = Object.assign(Object.assign({}, (_j = procedure._def.meta) === null || _j === void 0 ? void 0 : _j.openapi), defaultOpenApiMeta);
        }
        if (openapi && openapi.enabled !== false) {
            const type = getProcedureType(procedure);
            // @ts-ignore
            callback({ path, type, procedure, openapi });
        }
    }
};
exports.forEachOpenApiProcedure = forEachOpenApiProcedure;
//# sourceMappingURL=procedure.js.map