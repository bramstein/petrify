// If this is run from the command-line:
var petrify = require('./petrify'),
   util = require('util');


var displayEvent = function(eventname){
    return function(name){
        util.log(eventname + ': ' + name);
    };
};

var displayError = function(context_type){
    return function(err, context){
        util.log(
            'ERROR in ' + context + ' ' + context_type + ': ' +
            (err.message || err.toString()) +
            (err.stack ? '\n' + err.stack : '')
        );
    };
};

exports.run = function(options){
    var start = new Date().getTime();
    var runner = petrify.run(options);

    runner.data.addListener('load', displayEvent('load'));
    runner.templates.addListener('load', displayEvent('load'));
    runner.views.addListener('load', displayEvent('load'));
    runner.views.addListener('view_done', displayEvent('view_done'));

    runner.data.addListener('error', displayError('document'));
    runner.views.addListener('error',displayError('view'));
    runner.templates.addListener('error', displayError('template'));
    runner.addListener('error', displayError);

    runner.views.addListener('emit', function(view, path){
        util.log('emit: ' + view + ' => ' + path);
    });

    runner.addListener('finished', function(err){
        var duration = (new Date().getTime()) - start;
        if(err) util.puts('Errors during build (' + duration + 'ms)');
        else util.puts('Done (' + duration + 'ms)');
    });

    return runner;
};


// If this is run from the command-line:
if(module.id === '.'){

    var path = process.ARGV[2];
    require.paths.push(path);

    exports.run({
        data_dir: path + '/data',
        data_file_filter: /.*\.md$/,
        view_dir: path + '/views',
        template_dir: path + '/templates',
        output_dir: path + '/www',
        media_dirs: [path + '/media']
    });
}
