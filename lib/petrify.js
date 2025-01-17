
var fs = require('fs'),
    util = require('util'),
    path = require('path'),
    async = require('async'),
    events = require('events'),
    jsontemplate = require('json-template'),
    child_process = require('child_process'),
    markdown = require('markdown').markdown;
    findit = require('findit');

// iterates over a directory of files where the filename matches a regexp
exports.withFiles = function(dirname, pattern, fn, callback){

  var dirLengthWithSlash = (/^.*\/$/.test(dirname)) ? dirname.length : dirname.length+1;

  function handleError(err){
    callback(err);
    // stop callback being run by other readFile calls
    callback = function() {};
  }
  
  var finder = findit.find(dirname);

  var hitEnd = false;
  var total = 0;
  var waiting = 0;
  finder.on('file', function (file) {
    var relative_filename = file.slice(dirLengthWithSlash);
    if (pattern.test(relative_filename)) { //and matches pattern
      total += 1;
      waiting += 1;
      fs.readFile(file, function(err, data){
        if(err){ handleError(err); return; }
        var completed = total - waiting.length;
        fn(relative_filename, data.toString(), completed, total);
        waiting -= 1;
        if(hitEnd && !waiting){
          callback(null);
        }
      });
    }
  });

  finder.on('end', function () {
    hitEnd = true;
    if(!waiting){
      callback(null);
    }    
  });

  finder.on('error', function(err) {
    handleError(err);
  });
};

// require()'s modules from a directory and returns an object containing
// all of the results. Tests the exported properties of the modules to ensure
// the correct callbacks exist.
exports.loadViews = function(dirname){
    var emitter = new events.EventEmitter();
    var completed = 0;
    fs.readdir(dirname, function(err, files){
        if(err) return emitter.emit('error', err);
        if(!files.length) return emitter.emit('loaded', {});
        emitter.emit('loaded', files.reduce(function(a,x){
            var basename = path.basename(x);
            if(/\.js$/.exec(basename)){
                var module_name = basename.replace(/\.js$/,'');
                try {
                    a[module_name] = require(path.join(dirname, module_name));
                    completed++;
                    emitter.emit('load', module_name, completed, files.length);
                }
                catch (e) {
                    process.nextTick(function(){
                        emitter.emit('error', e, module_name);
                    });
                }
            }
            return a;
        }, {}));
    });
    return emitter;
};

// calls the 'run' callback on each view module, once exports.requirements have
// all completed processing.
exports.runViews = function(opts){
    var emitter = new events.EventEmitter();
    var context = {
        templates: opts.templates,
        data: opts.data,
        partials: {}
    };
    var emits_pending = {};
    var tasks = Object.keys(opts.views).reduce(function(a,k){
        var view = opts.views[k];
        emits_pending[k] = 0;
        var fn = function(callback){
            var viewEnv = {
                emit: function(path, data){
                    emits_pending[k]++;
                    exports.emit(opts.output_dir, path, data, function(err){
                        emits_pending[k]--;
                        if(err) {
                            emitter.emit('error', err, k);
                        }
                        else process.nextTick(function(){
                            emitter.emit('emit', k, path);
                        });
                    });
                },
                done: function(){
                    if(!emits_pending[k]){
                        process.nextTick(function(){
                            emitter.emit('view_done', k);
                        });
                        callback();
                    }
                    else {
                        var handler = function(){
                            if(!emits_pending[k]){
                                emitter.removeListener('emit', handler);
                                process.nextTick(function(){
                                    emitter.emit('view_done', k);
                                });
                                callback();
                            }
                        };
                        emitter.addListener('emit', handler);
                    }
                }
            };
            try {
                process.nextTick(function(){
                    emitter.emit('view_started', k);
                });
                view.run(viewEnv, context);
            }
            catch(e){
                process.nextTick(function(){
                    emitter.emit('error', e, k);
                    viewEnv.done();
                });
            }
        };
        a[k] = view.requires ? view.requires.concat([fn]): fn;
        return a;
    }, {});
    async.auto(tasks, function(){
        process.nextTick(function(){emitter.emit('finished');});
    });
    return emitter;
};

// saves data to the output directory, safely ignores url style leading slash,
// but does allow ability to emit outside of the directory using ../
exports.emit = function(output_dir, urlpath, data, callback){
    var filename = path.normalize(output_dir+'/'+urlpath.replace(/^\//, ''));
    var dirname = path.dirname(filename);
    output_dir = path.normalize(output_dir);
    // is filename a subdirectory of output_dir?
    if(filename.substr(0, output_dir.length) == path.normalize(output_dir)){
        path.exists(dirname, function(exists){
            if(!exists){
                child_process.exec('mkdir -p ' + dirname, function(err){
                    fs.writeFile(filename, data, callback);
                });
            }
            else {
                fs.writeFile(filename, data, callback);
            }
        });
    }
    else {
        callback(new Error('Attempted to emit file outside of output dir'));
    }
};


// parses markdown files exposing the metadata, html, jsonml, first h1 heading
// and filename as properties
exports.readFile = function(filename, data){
    var dialect = markdown.Markdown.dialects.Maruku;
    var jsonml = markdown.parse(data, dialect);
    var result = {};
    if(jsonml.length > 1 && !(jsonml[1] instanceof Array)){
        result.meta = jsonml[1];
    }
    result.heading = (function(){
        for(var i=0; i<jsonml.length; i++){
            var x = jsonml[i];
            if(x instanceof Array){
                if(x[0] == 'header' && x[1].level == 1){
                    return x[2];
                }
            }
        }
    })();
    result.jsonml = jsonml;
    result.html = markdown.toHTML(jsonml);

    var found_header = false;
    result.html_no_heading = markdown.toHTML(jsonml.filter(function(x){
        if(x instanceof Array){
            if(x[0] == 'header' && x[1].level == 1 && !found_header){
                found_header = true;
                return false;
            }
        }
        return true;
    }));
    result.first_paragraph = (function(){
        for(var i=0; i<result.jsonml.length; i++){
            var x = result.jsonml[i];
            if(x instanceof Array && x[0] == 'para'){
                return markdown.toHTML(['markdown', x]);
            }
        }
        return '';
    })();

    result.filename = filename; //use the full relative filename
    return result;
};

// reads markdown files form a data directory, passing an array of the
// results to a callback
exports.loadData = function(dirname, relFilePattern){
    var emitter = new events.EventEmitter();
    var data = [];
    exports.withFiles(
        dirname, relFilePattern,
        function(filename, fileData, completed, total){
            data.push(exports.readFile(filename, fileData));
            emitter.emit('load', filename, completed, total);
        },
        function(err){
            if(err) emitter.emit('error', err);
            else emitter.emit('loaded', data);
        }
    );
    return emitter;
};

// reads jsont templates from a template directory, passing an object
// containing getters for parsing the templates keyed by filename
exports.loadTemplates = function(template_dir){
    var emitter = new events.EventEmitter();
    var templates = {};
    exports.withFiles(template_dir, /.*\.jsont$/, function(filename, data){
        var cache;
        templates.__defineGetter__(filename, function(){
            if(!cache){
                cache = new jsontemplate.Template(data);
                cache._expand = cache.expand;
                cache.expand = function(){
                    try {
                        return cache._expand.apply(cache, arguments);
                    }
                    catch (e){
                        // add a more helpful error message:
                        e.message = "Error expanding template '" +
                            filename + "': " + e.message;
                        throw e;
                    }
                };
            }
            return cache;
        });
    }, function(err){
        if(err) emitter.emit('error', err);
        else {
            process.nextTick(function(){
                emitter.emit('loaded', templates);
            });
        }
    });
    return emitter;
};

// builds a site
exports.run = function(opt){
    var emitter = new events.EventEmitter();
    async.auto({
        templates: function(callback){
            emitter.templates = exports.loadTemplates(opt.template_dir);
            emitter.templates.addListener('error', function(err, templates){
                callback();
            });
            emitter.templates.addListener('loaded', function(templates){
                opt.templates = templates;
                callback();
            });
        },
        views: function(callback){
            emitter.views = exports.loadViews(opt.view_dir);
            emitter.views.addListener('error', function(err, view){
                callback();
            });
            emitter.views.addListener('loaded', function(views){
                opt.views = views;
                callback();
            });
        },
        data: function(callback){
            emitter.data = exports.loadData(opt.data_dir, opt.data_file_filter);
            emitter.data.addListener('error', function(err, doc){
                callback();
            });
            emitter.data.addListener('loaded', function(data){
                opt.data = data;
                callback();
            });
        },
        removedir: function(callback){
            path.exists(opt.output_dir, function(exists){
                if(exists){
                    child_process.exec('rm -r '+opt.output_dir, function(err){
                        if(err) emitter.emit('error', err);
                        callback();
                    });
                }
                else callback();
            });
        },
        mkdir: ['removedir', function(callback){
            child_process.exec('mkdir ' + opt.output_dir, function(err){
                if(err) emitter.emit('error', err);
                callback();
            });
        }],
        media_dirs: ['mkdir', function(callback){
            if(opt.media_dirs && opt.media_dirs.length){
                var waiting = opt.media_dirs.length;
                opt.media_dirs.forEach(function(dir){
                    child_process.exec(
                        'cp -r ' + dir + ' ' + opt.output_dir,
                        function(err){
                            if(err) emitter.emit('error', err);
                            waiting--;
                            if(!waiting){
                                callback();
                            }
                        }
                    );
                });
            }
            else {
                callback();
            }
        }]
    }, function(){
        var e;
        var runViews = exports.runViews(opt);
        runViews.addListener('view_started', function(name){
            emitter.views.emit('view_started', name);
        });
        runViews.addListener('emit', function(name, path){
            emitter.views.emit('emit', name, path);
        });
        runViews.addListener('error', function(err, view){
            emitter.views.emit('error', err, view);
            e = err;
        });
        runViews.addListener('view_done', function(name){
            emitter.views.emit('view_done', name);
        });
        runViews.addListener('finished', function(err){
            emitter.views.emit('finished', e);
            emitter.emit('finished', e);
        });
    });
    return emitter;
};
