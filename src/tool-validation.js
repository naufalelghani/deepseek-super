'use strict';

const { isDeepStrictEqual } = require('node:util');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case 'object': return isPlainObject(value);
      case 'array': return Array.isArray(value);
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      default: return true;
    }
  });
}

function validateAgainstSchema(value, schema, path = 'input') {
  if (!isPlainObject(schema)) return null;

  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    return path + ' must equal the declared constant.';
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => isDeepStrictEqual(value, item))) {
    return path + ' must match one of the allowed enum values.';
  }
  if (schema.type && !matchesType(value, schema.type)) {
    return path + ' must be of type ' + (Array.isArray(schema.type) ? schema.type.join('|') : schema.type) + '.';
  }

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const error = validateAgainstSchema(value, part, path);
      if (error) return error;
    }
  }
  if (Array.isArray(schema.anyOf) &&
      !schema.anyOf.some((part) => validateAgainstSchema(value, part, path) === null)) {
    return path + ' does not match any allowed schema.';
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((part) => validateAgainstSchema(value, part, path) === null).length;
    if (matches !== 1) return path + ' must match exactly one allowed schema.';
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return path + '.' + key + ' is required.';
      }
    }
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const error = validateAgainstSchema(value[key], properties[key], path + '.' + key);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return path + '.' + key + ' is not allowed.';
      } else if (isPlainObject(schema.additionalProperties)) {
        const error = validateAgainstSchema(value[key], schema.additionalProperties, path + '.' + key);
        if (error) return error;
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return path + ' must contain at least ' + schema.minItems + ' item(s).';
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return path + ' must contain at most ' + schema.maxItems + ' item(s).';
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const error = validateAgainstSchema(value[index], schema.items, path + '[' + index + ']');
        if (error) return error;
      }
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      return path + ' must be at least ' + schema.minLength + ' character(s).';
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      return path + ' must be at most ' + schema.maxLength + ' character(s).';
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return path + ' must be greater than or equal to ' + schema.minimum + '.';
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return path + ' must be less than or equal to ' + schema.maximum + '.';
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return path + ' must be greater than ' + schema.exclusiveMinimum + '.';
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      return path + ' must be less than ' + schema.exclusiveMaximum + '.';
    }
  }

  return null;
}

function validateToolCalls(toolCalls, tools) {
  const specs = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool.name, tool]));
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || typeof call.name !== 'string' || !call.name) {
      return { valid: false, error: 'Tool call is missing a valid name.' };
    }
    const spec = specs.get(call.name);
    if (!spec) {
      return { valid: false, error: 'Tool name "' + call.name + '" was not declared in this request.' };
    }
    if (!isPlainObject(call.input)) {
      return { valid: false, error: 'Arguments for tool "' + call.name + '" must be a JSON object.' };
    }
    const schema = isPlainObject(spec.input_schema) ? spec.input_schema : {};
    const error = validateAgainstSchema(call.input, schema, call.name + '.arguments');
    if (error) return { valid: false, error };
  }
  return { valid: true, error: null };
}

module.exports = { validateAgainstSchema, validateToolCalls, isPlainObject };
