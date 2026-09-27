// The OpenAPI description of the API in api.ts, served at /api/openapi.json and
// browsable with Swagger UI at /api/docs. It is written by hand: keep it in
// step with the routes, which tests/api.test.ts checks it lists.

const json = (schema: object) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const error = (description: string) => ({ description, content: json(ref('Error')) });

const filePath = {
  name: 'path',
  in: 'path',
  required: true,
  description: 'The path of the file, relative to the open folder, e.g. `a/b.xml`. It must end in .xml. The slashes between folders may be sent as is or encoded as `%2F`.',
  schema: { type: 'string' },
  example: 'examples/hello.xml',
};

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Behavior editor API',
    version: '0.1.0',
    license: { name: 'MIT', identifier: 'MIT' },
    description: [
      'The HTTP API of the behavior editor, over a folder of BehaviorTree.CPP XML files on the server.',
      '',
      'A file is at `/api/files/` followed by its path in the open folder. `PUT` creates it (201 Created) or overwrites it (200 OK).',
      '',
      'Writes are conditional, so that nobody overwrites a change they have not seen: `PUT` and `DELETE` of a file take',
      'the ETag of the version read in `If-Match`, or `If-None-Match: *` to create a file only if it does not exist,',
      'and fail with 412 Precondition Failed otherwise. Without either header they write unconditionally.',
      '',
      'Changes also take the folder the client loaded in `X-Behaviors-Root`, and fail with 409 Conflict if another',
      'folder was opened since, e.g. from another tab.',
      '',
      '**The requests run against the real folder**: "Try it out" on a write changes the files on disk.',
    ].join('\n'),
  },
  // Replaced with the address the client used when served, see serverUrl in api.ts.
  servers: [{ url: '/' }],
  // No authentication: the editor serves whoever can reach its port.
  security: [],
  tags: [
    { name: 'Files', description: 'The behavior files of the open folder' },
    { name: 'Folders', description: 'Choosing the folder to open' },
    { name: 'Validation', description: 'Validation with BehaviorTree.CPP itself' },
  ],
  paths: {
    '/api/workspace': {
      get: {
        tags: ['Files'],
        operationId: 'getWorkspace',
        summary: 'Read the open folder',
        description: 'The open folder, its behavior files with their contents and ETags, and the built-in node models of the installed BehaviorTree.CPP. XML files that are not behaviors, e.g. package.xml, are left out.',
        responses: {
          200: { description: 'The folder and its files', content: json(ref('Workspace')) },
          500: error('The folder cannot be read'),
        },
      },
    },
    '/api/files/{path}': {
      put: {
        tags: ['Files'],
        operationId: 'putFile',
        summary: 'Create or overwrite a file',
        description: 'Writes the body to the file, creating its folders if needed. The write is atomic: a reader never sees half a file.',
        parameters: [
          filePath,
          { $ref: '#/components/parameters/IfMatch' },
          { $ref: '#/components/parameters/IfNoneMatch' },
          { $ref: '#/components/parameters/BehaviorsRoot' },
        ],
        requestBody: {
          required: true,
          description: 'The XML of the file. At most 10 MB.',
          content: { 'application/xml': { schema: { type: 'string' } } },
        },
        responses: {
          200: {
            description: 'Overwrote the file',
            headers: { ETag: { description: 'The ETag of the new content', schema: { type: 'string' } } },
            content: json({ type: 'object', required: ['etag'], properties: { etag: { type: 'string' } } }),
          },
          201: {
            description: 'Created the file',
            headers: { ETag: { description: 'The ETag of the new content', schema: { type: 'string' } } },
            content: json({ type: 'object', required: ['etag'], properties: { etag: { type: 'string' } } }),
          },
          400: error('The path is missing, absolute, outside the folder or not an .xml file'),
          409: error('Another folder was opened since the one in X-Behaviors-Root'),
          412: error('The file was changed or deleted on disk, or already exists with If-None-Match: *. `etag` is the ETag of the file on disk, if it exists.'),
          413: error('The body is larger than 10 MB'),
        },
      },
      delete: {
        tags: ['Files'],
        operationId: 'deleteFile',
        summary: 'Delete a file',
        description: 'Deleting a file that does not exist succeeds, unless If-Match asks for a version of it.',
        parameters: [
          filePath,
          { $ref: '#/components/parameters/IfMatch' },
          { $ref: '#/components/parameters/BehaviorsRoot' },
        ],
        responses: {
          200: { description: 'Deleted', content: json({ type: 'object', required: ['ok'], properties: { ok: { const: true } } }) },
          400: error('The path is missing, absolute, outside the folder or not an .xml file'),
          409: error('Another folder was opened since the one in X-Behaviors-Root'),
          412: error('The file was changed or deleted on disk. `etag` is the ETag of the file on disk, if it exists.'),
        },
      },
    },
    '/api/validate': {
      post: {
        tags: ['Validation'],
        operationId: 'validate',
        summary: 'Validate with BehaviorTree.CPP',
        description: 'Loads the given files with the native validator (built by bin/build.sh), which runs the real BehaviorTree.CPP. The contents may differ from what is on disk, e.g. unsaved edits. Without the native validator, answers `available: false`.',
        parameters: [{ $ref: '#/components/parameters/BehaviorsRoot' }],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['files'],
            properties: { files: { type: 'array', items: ref('File') } },
          }),
        },
        responses: {
          200: { description: 'The issues found', content: json(ref('ValidationResult')) },
          400: error('The body is not JSON, has no files, or a path is not a valid .xml path in the folder'),
          409: error('Another folder was opened since the one in X-Behaviors-Root'),
          413: error('The body is larger than 10 MB'),
        },
      },
    },
    '/api/folders': {
      get: {
        tags: ['Folders'],
        operationId: 'listFolders',
        summary: 'List the sub-folders of a folder',
        description: 'For the Open folder dialog. Only the base folder (BEHAVIORS_BASE, or the home folder of the server\'s user) and the folder opened at startup can be browsed.',
        parameters: [{
          name: 'path',
          in: 'query',
          description: 'The absolute path of the folder. Defaults to the open folder.',
          schema: { type: 'string' },
        }],
        responses: {
          200: { description: 'The sub-folders', content: json(ref('Folders')) },
          400: error('The path is not absolute, or not a folder'),
          403: error('The folder is outside those that can be opened, or cannot be read'),
        },
      },
    },
    '/api/root': {
      put: {
        tags: ['Folders'],
        operationId: 'openFolder',
        summary: 'Open another folder',
        description: 'Changes the open folder for every client: the others get 409 Conflict on their next change.',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string', description: 'The absolute path of the folder' } },
          }),
        },
        responses: {
          200: { description: 'Opened', content: json({ type: 'object', required: ['root'], properties: { root: { type: 'string' } } }) },
          400: error('The body is not JSON, or the path is not absolute or not a folder'),
          403: error('The folder is outside those that can be opened'),
        },
      },
    },
  },
  components: {
    parameters: {
      IfMatch: {
        name: 'If-Match',
        in: 'header',
        description: 'Write only over this version: the ETag the client read, or `*` for any existing file.',
        schema: { type: 'string' },
      },
      IfNoneMatch: {
        name: 'If-None-Match',
        in: 'header',
        description: '`*` to create the file only if it does not exist.',
        schema: { type: 'string' },
      },
      BehaviorsRoot: {
        name: 'X-Behaviors-Root',
        in: 'header',
        description: 'The folder the client loaded, URL-encoded. Refuses the change if another folder was opened since.',
        schema: { type: 'string' },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          etag: { type: 'string', description: 'With 412: the ETag of the file on disk, if it exists' },
        },
      },
      File: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Relative to the open folder, with / separators' },
          content: { type: 'string', description: 'The XML' },
        },
      },
      StoredFile: {
        allOf: [ref('File'), {
          type: 'object',
          required: ['etag'],
          properties: { etag: { type: 'string', description: 'For If-Match, to save over this version only' } },
        }],
      },
      Workspace: {
        type: 'object',
        required: ['root', 'files', 'nativeValidator'],
        properties: {
          root: { type: 'string', description: 'The absolute path of the open folder' },
          files: { type: 'array', items: ref('StoredFile') },
          builtins: {
            type: 'array',
            items: ref('NodeModel'),
            description: 'The built-in node models of the installed BehaviorTree.CPP, when the native validator is built',
          },
          nativeValidator: { type: 'boolean', description: 'Whether POST /api/validate can run BehaviorTree.CPP' },
        },
      },
      NodeModel: {
        type: 'object',
        required: ['id', 'category', 'ports'],
        properties: {
          id: { type: 'string', example: 'Sequence' },
          category: { enum: ['Action', 'Condition', 'Control', 'Decorator', 'SubTree'] },
          ports: { type: 'array', items: ref('PortModel') },
          description: { type: 'string' },
          builtin: { type: 'boolean' },
        },
      },
      PortModel: {
        type: 'object',
        required: ['direction', 'name'],
        properties: {
          direction: { enum: ['input', 'output', 'inout'] },
          name: { type: 'string' },
          type: { type: 'string' },
          default: { type: 'string' },
          description: { type: 'string' },
        },
      },
      ValidationResult: {
        type: 'object',
        required: ['available', 'issues'],
        properties: {
          available: { type: 'boolean', description: 'Whether the native validator is built' },
          issues: { type: 'array', items: ref('Issue') },
          output: { type: 'string', description: 'Anything the validator printed that is not a finding, e.g. a crash' },
        },
      },
      Issue: {
        type: 'object',
        required: ['severity', 'message', 'file'],
        properties: {
          severity: { enum: ['error', 'warning', 'info'] },
          message: { type: 'string' },
          file: { type: 'string' },
          tree: { type: 'string', description: 'The ID of the tree at fault' },
          source: { enum: ['editor', 'btcpp'] },
        },
      },
      Folders: {
        type: 'object',
        required: ['path', 'folders', 'xmlFiles'],
        properties: {
          path: { type: 'string' },
          parent: { type: 'string', description: 'Absent at the top of the folders that can be opened' },
          folders: { type: 'array', items: { type: 'string' } },
          xmlFiles: { type: 'integer', description: 'The number of XML files directly in the folder' },
        },
      },
    },
  },
};

/** The page of Swagger UI, which loads its files from /api/docs/. */
export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Behavior editor API</title>
  <link rel="icon" href="/api/docs/favicon-32x32.png">
  <link rel="stylesheet" href="/api/docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>
`;
