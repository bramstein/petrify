#!/usr/bin/env node

var buildrunner = require('../lib/buildrunner');

buildrunner.run({
    data_dir: __dirname + '/data',
    view_dir: __dirname + '/views',
    template_dir: __dirname + '/templates',
    output_dir: __dirname + '/www',
    media_dirs: [__dirname + '/media']
});
