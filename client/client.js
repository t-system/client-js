var btoa = require('btoa');
var Search = require('./search');
var jQuery = require('./jquery');
var $ = jQuery;

module.exports = FhirClient;

function absolute(id, server) {
  if (id.match(/^http/)) return id;
  if (id.match(/^urn/)) return id;

  // strip leading slash
  if (id.charAt(0) == "/") id = id.substr(1);

  return server.serviceUrl + '/' + id;
}

var regexpSpecialChars = /([\[\]\^\$\|\(\)\\\+\*\?\{\}\=\!])/gi;

function relative(id, server) {
  if (!id.match(/^http/)) {
    id = server.serviceUrl + '/' + id
  }
  var quotedBase = ( server.serviceUrl + '/' ).replace(regexpSpecialChars, '\\$1');
  var matcher = new RegExp("^"+quotedBase + "([^/]+)/([^/]+)(?:/_history/(.*))?$");
  var match = id.match(matcher);
  if (match === null) {
    throw "Couldn't determine a relative URI for " + id;
  }

  var params = {
    resource: match[1],
    id: match[2],
    version: match[3]
  };

  return params;
}

function getPreviousToken(){
  var ret = sessionStorage.tokenResponse;
  if (ret) ret = JSON.parse(ret);
  return ret;
}

function completeRefreshTokenExchange(){

    var tokenResponse = getPreviousToken();

    var params = {
      code: tokenResponse.code,
      state: tokenResponse.state
    };
  
    var ret =  $.Deferred();
    var state = JSON.parse(sessionStorage[params.state]);

    $.ajax({

      url: state.provider.oauth2.token_uri,
      type: 'POST',
      data: {
        client_id: 'my_web_app',
        grant_type: 'refresh_token',
        refresh_token: tokenResponse.refresh_token,
        state: tokenResponse.state
      },
    }).done(function(authz){
      authz = $.extend(authz, params);
      ret.resolve(authz);
    }).fail(function(){
      console.log("failed to exchange code for access_token", arguments);
      ret.reject();
    });

    return ret.promise();
}

function completePageReload(){
  var d = $.Deferred();
  var tokenResponse = getPreviousToken();
  
  if (tokenResponse !== undefined) {
      if (tokenResponse.refresh_token !== undefined) {
        $.when(completeRefreshTokenExchange()).then(function (tokenResponse) {
            d.resolve(tokenResponse);
        }, function () {
            d.reject();
        });
      } else {
        d.resolve(tokenResponse);
      }
  } else {
      d.reject();
  }

  return d;
}

function readyArgs(){

  var input = null;
  var callback = function(){};
  var errback = function(){};
  var client = null;

  if (arguments.length === 0){
    throw "Can't call 'ready' without arguments";
  } else if (arguments.length === 1){
    callback = arguments[0];
  } else if (arguments.length === 2){
    if (typeof arguments[0] === 'function'){
      callback = arguments[0];
      errback = arguments[1];
    } else if (typeof arguments[0] === 'object'){
      input = arguments[0];
      callback = arguments[1];
    } else {
      throw "ready called with invalid arguments";
    }
  } else if (arguments.length === 3){
    input = arguments[0];
    callback = arguments[1];
    errback = arguments[2];
  } else if (arguments.length === 4){
    input = arguments[0];
    callback = arguments[1];
    errback = arguments[2];
    client = arguments[3];
  } else {
    throw "ready called with invalid arguments";
  }

  return {
    input: input,
    callback: callback,
    errback: errback,
    client: client
  };
}

function processTokenResponse(tokenResponse, callback, errback){

    if (!tokenResponse || !tokenResponse.state) {
      return errback("No 'state' parameter found in authorization response.");
    }
    
    sessionStorage.tokenResponse = JSON.stringify(tokenResponse);

    var state = JSON.parse(sessionStorage[tokenResponse.state]);
    if (state.fake_token_response) {
      tokenResponse = state.fake_token_response;
    }

    var fhirClientParams = {
      serviceUrl: state.provider.url,
      patientId: tokenResponse.patient
    };
    
    if (tokenResponse.id_token) {
        var id_token = tokenResponse.id_token;
        var payload = jwt.decode(id_token);
        fhirClientParams["userId"] = payload["profile"]; 
    }

    if (tokenResponse.access_token !== undefined) {
      fhirClientParams.auth = {
        type: 'bearer',
        token: tokenResponse.access_token
      };
    } else if (!state.fake_token_response){
      return errback("Failed to obtain access token.");
    }

    var ret = client || FhirClient(fhirClientParams);
    ret.init(fhirClientParams);
    ret.state = JSON.parse(JSON.stringify(state));
    ret.tokenResponse = JSON.parse(JSON.stringify(tokenResponse));
    callback(ret);
}

function ClientPrototype(){};
var clientUtils = require('./utils');
Object.keys(clientUtils).forEach(function(k){
  ClientPrototype.prototype[k] = clientUtils[k];
});

function FhirClient(p) {
  // p.serviceUrl
  // p.auth {
    //    type: 'none' | 'basic' | 'bearer'
    //    basic --> username, password
    //    bearer --> token
    // }

    var cache = {};
    var client = new ClientPrototype();

    var server = {};
    
    client.init = function (p) {
        server = client.server = {
          serviceUrl: p.serviceUrl,
          auth: p.auth
        };

        client.patientId = p.patientId;
        client.userId = p.userId;
    };
    
    client.init(p);

    client.cache = {
      get: function(p) {
        var url = absolute(typeof p === 'string' ? p : (p.resource + '/'+p.id), server);
        if (url in cache) {
          return getLocal(url);
        }
        return null;
      }
    };


    server.auth = server.auth ||  {
      type: 'none'
    };

    if (!client.server.serviceUrl || !client.server.serviceUrl.match(/https?:\/\/.+[^\/]$/)) {
      throw "Must supply a `server` propery whose `serviceUrl` begins with http(s) " + 
        "and does NOT include a trailing slash. E.g. `https://fhir.aws.af.cm/fhir`";
    }

    client.indexResource = function(id, r) {
      var ret = [r];
      cache[absolute(id, server)] = r;
      return ret;
    };

    client.indexBundle = function(data) {
      var ret = [];
      (data.entry || []).forEach(function(e){
        var r = e.resource;
        var id = r.resourceType + "/" + r.id;
        var more = client.indexResource(id, r);
        [].push.apply(ret, more);
      });
      return ret; 
    };

    client.authenticated = function(p) {
      if (server.auth.type === 'none') {
        return p;
      }

      var h;
      if (server.auth.type === 'basic') {
        h = "Basic " + btoa(server.auth.username + ":" + server.auth.password);
      } else if (server.auth.type === 'bearer') {
        h = "Bearer " + server.auth.token;
      }
      if (!p.headers) {p.headers = {};}
      p.headers['Authorization'] = h
      //p.beforeSend = function (xhr) { xhr.setRequestHeader ("Authorization", h); }

      return p;
    };

    function handleReference(p){
      return function(from, to) {

        // Resolve any of the following:
        // 1. contained resource
        // 2. already-fetched resource
        // 3. not-yet-fetched resource

        if (to.reference === undefined) {
          throw "Can't follow a non-reference: " + to;
        }

        if (to.reference.match(/^#/)) {
          return p.contained(from, to.reference.slice(1));
        } 

        var url = absolute(to.reference, server);
        if (url in cache) {
          return p.local(url);
        }

        if (!p.remote) {
          throw "Can't look up unfetched resource " + url;
        }

        return p.remote(url);
      }
    };
    
    function handleBinary(p){
      return function(from, to) {

        var url = absolute(to, server);
        if (url in cache) {
          return p.local(url);
        }

        if (!p.remote) {
          throw "Can't look up unfetched resource " + url;
        }

        return p.remote(url);
      }
    };

    client.cachedLink = handleReference({
      contained: getContained,
      local: getLocal
    });

    client.followLink = handleReference({
      contained: followContained,
      local: followLocal,
      remote: followRemote
    });
    
    client.followBinary = handleBinary({
      local: followLocal,
      remote: followRemoteBinary
    });

    function getContained(from, id) {
      var matches = from.contained.filter(function(c){
       // Note: `.id` is correct, but `._id` was a longtime (incorrect)
       // production of the FHIR Java RI serialization routine. We checl
       // both here for compatibility.
        return (c.id === id || c._id === id); 
      });
      if (matches.length !== 1)  {
        return null;
      }
      return matches[0];
    }

    function getLocal(url) {
      return cache[url];
    }

    function followContained(from, id) {
      var ret = new $.Deferred();
      var val = getContained(from, id);
      setTimeout(function(){
        if (val === null) {
          return ret.reject("No contained resource matches #"+id);
        }
        return ret.resolve(val);
      }, 0);
      return ret;
    };

    function followLocal(url) {
      var ret = new $.Deferred();
      var val = getLocal(url);
      setTimeout(function(){
        if (val === null) {
          return ret.reject("No local resource matches #"+id);
        }
        return ret.resolve(val);
      }, 0);
      return ret;
    };

    function followRemote(url) {
      var getParams = relative(url, server);
      return client.get(getParams);
    };
    
    function followRemoteBinary(url) {
      var getParams = relative(url, server);
      return client.getBinary(getParams);
    };

    client.get = function(p, finish) {
      // p.resource, p.id, ?p.version, p.include

      var ret = new $.Deferred();
      var url = server.serviceUrl + '/' + p.resource + '/' + p.id;

      $.ajax(client.authenticated({
        type: 'GET',
        url: url,
        dataType: 'json'
      }))
      .done(function(data, status){
        var ids = client.indexResource(url, data);
        if (ids.length !== 1) {
          ret.reject("Didn't get exactly one result for " + url);
        }
        ret.resolve(ids[0]);
      })
      .fail(function(){
        if (client.tokenResponse.refresh_token !== undefined && !finish) {
          completePageReload().done(function (tokenResponse) {
            processTokenResponse(tokenResponse, function(client){
                $.when(client.get(p, true)).then(function(r){
                    ret.resolve(r);
                }, function (err) {
                    ret.reject("Could not fetch " + url, arguments);
                });
            }, ret.reject, client);
          }).fail(function(){
            ret.reject("Could not fetch " + url, arguments);
          });
        } else {
          ret.reject("Could not fetch " + url, arguments);
        }
      });
      return ret;
    };
    
    client.getBinary = function(p) {

      var ret = new $.Deferred();
      var url = server.serviceUrl + '/' + p.resource + '/' + p.id;

      $.ajax(client.authenticated({
        type: 'GET',
        url: url,
        dataType: 'blob'
      }))
      .done(function(blob){
        ret.resolve(blob);
      })
      .fail(function(){
        ret.reject("Could not fetch " + url, arguments);
      });
      return ret;
    };

    client.urlFor = function(searchSpec){
      return client.server.serviceUrl+searchSpec.queryUrl();
    }

    client.search = function(searchSpec){
      // p.resource, p.count, p.searchTerms
      var s = Search({
        client: client,
        spec: searchSpec
      });

      return s.execute();
    }

    client.drain =  function(searchSpec, batch){
      var d = $.Deferred();

      if (batch === undefined){
        var db = [];
        batch = function(vs) {
          vs.forEach(function(v){
            db.push(v);
          }); 
        }
      }

      db = db || {};
      client.search(searchSpec)
      .done(function drain(vs, cursor){
        batch(vs);
        if (cursor.hasNext()){
          cursor.next().done(drain);
        } else {
          d.resolve();
        } 
      }).fail(function (err){
          d.reject(err);
      });
      return d.promise();
    };

    var specs = require('./search-specification')({
      "search": client,
      "drain": client
    });

    function patientPropertyName(searchSpec){
      var propertyName = null;
      ['patient', 'subject'].forEach(function(pname){
        if (typeof searchSpec[pname] === 'function'){
          propertyName = pname;
        }
      });
      return propertyName;
    }

    function withDefaultPatient(searchSpec){
      var propertyName = patientPropertyName(searchSpec);
      if (propertyName !== null && client.patientId){
        searchSpec = searchSpec[propertyName](specs.Patient._id(client.patientId));
      } else if (searchSpec.resourceName === 'Patient' && client.patientId){
        searchSpec = searchSpec._id(client.patientId);
      } else {
        searchSpec = null;
      }

      return searchSpec;
    }

    function getterFor(r){
      return function(id){

        if (r.resourceName === 'Patient' && id === undefined){
          id = client.patientId
        }

        return client.get({
          resource: r.resourceName,
          id: id
        });
      }
    };

    function writeTodo(){
      throw "Write functionality not implemented.";
    };

    client.context = {};

    client.context.user = {
      'read': function(){
        var userId = client.userId;
        var ret;
        if (userId) {
            $.each(["Practitioner", "Patient", "RelatedPerson"], function (id, type) {
                if (userId.indexOf(type) >= 0) {
                    userId = userId.split(type + "/")[1];
                    ret = client.api[type].read(userId);
                }
            });
        }
        return ret;
      }
    };

    client.context.patient = {
      'read': function(){
        return client.api.Patient.read(client.patientId);
      }
    };

    client.api = {};

    // Create SearchSpec-specific handlers
    // as properties on some target object
    // e.g. target.Alert, target.Condition, etc.
    function decorateWithApi(target, tweaks){

      tweaks = tweaks || {filter:function(){return true;}};

      Object.keys(specs).forEach(function(r){

        if (!tweaks.filter(specs[r])){
          return;
        }

        target[r] = {
          read: getterFor(specs[r]),
          post: writeTodo,
          put: writeTodo,
          delete: writeTodo,
          drain: function(){
            return target[r].where.drain();
          },
          search: function(){
            return target[r].where.search();
          },
          where: specs[r]
        };

        if (tweaks.where){
           target[r].where = tweaks.where(target[r].where);
        }

      });
    }

    decorateWithApi(client.api);
    decorateWithApi(client.context.patient, {
      filter: withDefaultPatient,
      where: withDefaultPatient
    });

    return client;
}

// Patch jQuery AJAX mechanism to receive blob objects via XMLHttpRequest 2. Based on:
//    https://gist.github.com/aaronk6/bff7cc600d863d31a7bf
//    http://www.artandlogic.com/blog/2013/11/jquery-ajax-blobs-and-array-buffers/

/**
 * Register ajax transports for blob send/recieve and array buffer send/receive via XMLHttpRequest Level 2
 * within the comfortable framework of the jquery ajax request, with full support for promises.
 *
 * Notice the +* in the dataType string? The + indicates we want this transport to be prepended to the list
 * of potential transports (so it gets first dibs if the request passes the conditions within to provide the
 * ajax transport, preventing the standard transport from hogging the request), and the * indicates that
 * potentially any request with any dataType might want to use the transports provided herein.
 *
 * Remember to specify 'processData:false' in the ajax options when attempting to send a blob or arraybuffer -
 * otherwise jquery will try (and fail) to convert the blob or buffer into a query string.
 */
jQuery.ajaxTransport("+*", function(options, originalOptions, jqXHR){
    // Test for the conditions that mean we can/want to send/receive blobs or arraybuffers - we need XMLHttpRequest
    // level 2 (so feature-detect against window.FormData), feature detect against window.Blob or window.ArrayBuffer,
    // and then check to see if the dataType is blob/arraybuffer or the data itself is a Blob/ArrayBuffer
    if (window.FormData && ((options.dataType && (options.dataType === 'blob' || options.dataType === 'arraybuffer')) ||
        (options.data && ((window.Blob && options.data instanceof Blob) ||
            (window.ArrayBuffer && options.data instanceof ArrayBuffer)))
        ))
    {
        return {
            /**
             * Return a transport capable of sending and/or receiving blobs - in this case, we instantiate
             * a new XMLHttpRequest and use it to actually perform the request, and funnel the result back
             * into the jquery complete callback (such as the success function, done blocks, etc.)
             *
             * @param headers
             * @param completeCallback
             */
            send: function(headers, completeCallback){
                var xhr = new XMLHttpRequest(),
                    url = options.url || window.location.href,
                    type = options.type || 'GET',
                    dataType = options.dataType || 'text',
                    data = options.data || null,
                    async = options.async || true,
                    key;

                xhr.addEventListener('load', function(){
                    var response = {}, status, isSuccess;

                    isSuccess = xhr.status >= 200 && xhr.status < 300 || xhr.status === 304;

                    if (isSuccess) {
                        response[dataType] = xhr.response;
                    } else {
                        // In case an error occured we assume that the response body contains
                        // text data - so let's convert the binary data to a string which we can
                        // pass to the complete callback.
                        response.text = String.fromCharCode.apply(null, new Uint8Array(xhr.response));
                    }

                    completeCallback(xhr.status, xhr.statusText, response, xhr.getAllResponseHeaders());
                });

                xhr.open(type, url, async);
                xhr.responseType = dataType;

                for (key in headers) {
                    if (headers.hasOwnProperty(key)) xhr.setRequestHeader(key, headers[key]);
                }
                xhr.send(data);
            },
            abort: function(){
                jqXHR.abort();
            }
        };
    }
});
