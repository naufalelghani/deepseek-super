'use strict';

const { BACKEND } = require('./config');

module.exports = BACKEND === 'qwen'
  ? require('./browser-qwen')
  : require('./browser-deepseek');
