import { expect } from 'chai';
import Ajv from 'ajv';
import * as url from 'url';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-types';
import draft4MetaSchema from 'ajv/lib/refs/json-schema-draft-04.json';
import draft7MetaSchema from 'ajv/lib/refs/json-schema-draft-07.json';
import * as schemaTestsRunner from './schemaTestsRunner';
import 'mocha';
import { findCycle } from './cycleCheck';

const readFile = promisify(fs.readFile);

const schemasFolder = __dirname + '/../schemas/';
const schemaTestsFolder = __dirname + '/../tests/';
const testSchemasFolder = __dirname + '/schemas/';
const templateTestsFolder = __dirname + '/templateTests/';
const armSchemasPrefix = /^https?:\/\/schema\.management\.azure\.com\/schemas\//
const jsonSchemaDraft4Prefix = /^https?:\/\/json-schema\.org\/draft-04\/schema/
const jsonSchemaDraft7Prefix = /^https?:\/\/json-schema\.org\/draft-07\/schema/

const ajvInstance = new Ajv({
  loadSchema: loadSchema,
  strictDefaults: true,
  schemaId: 'id',
  meta: false
  }).addMetaSchema(draft4MetaSchema)
    .addMetaSchema(draft7MetaSchema)
  .addFormat('int32',  /.*/)
  .addFormat('duration',  /.*/)
  .addFormat('password',  /.*/);

async function loadRawSchema(uri: string) : Promise<string> {
  const hashIndex = uri.indexOf("#");
  if (hashIndex !== -1) {
    uri = uri.substring(0, hashIndex);
  }

  let jsonPath : string;
  if (uri.match(armSchemasPrefix)) {
    jsonPath = uri.replace(armSchemasPrefix, schemasFolder);
  }
  else if (uri.match(jsonSchemaDraft4Prefix)) {
    return JSON.stringify(draft4MetaSchema);
  }
  else if (uri.match(jsonSchemaDraft7Prefix)) {
      return JSON.stringify(draft7MetaSchema);
  }
  else {
    jsonPath = uri;
  }

  if (jsonPath.startsWith("http:") || jsonPath.startsWith("https:")) {
    throw new Error(`Unsupported JSON path ${jsonPath}`);
  }

  return await readFile(jsonPath, { encoding: "utf8" });
}

async function loadSchema(uri: string) : Promise<object> {
  const rawSchema = await loadRawSchema(uri);

  return JSON.parse(rawSchema);
}

function listSchemaPaths(basePath: string): string[] {
  let results: string[] = [];

  for (const subPathName of fs.readdirSync(basePath)) {
    const subPath = path.resolve(`${basePath}/${subPathName}`);

    const fileStat = fs.statSync(subPath);
    if (fileStat.isDirectory()) {
      const pathResults = listSchemaPaths(subPath);
      results = results.concat(pathResults);
      continue;
    }

    if (!fileStat.isFile()) {
      continue;
    }

    results.push(subPath);
  }

  return results;
}

const metaSchemaPaths = [
  'http://json-schema.org/draft-04/schema',
  testSchemasFolder + 'ResourceMetaSchema.json',
];

// Cyclic schemas cause an issue for ARM export, but we have a few already
// 'known' bad schemas. Please do not add to this list unless you are sure
// this will not cause a problem in ARM.
const schemasToSkipForCyclicValidation = new Set([
  '2017-09-01-preview/Microsoft.DataFactory.json',
  '2018-06-01/Microsoft.DataFactory.json',
  '2018-07-01/Microsoft.Media.json',
  '2018-11-01-preview/Microsoft.Billing.json',
].map(p => path.resolve(`${schemasFolder}/${p}`)));

const schemasToSkip = [
  '0.0.1-preview/CreateUIDefinition.CommonControl.json',
  '0.0.1-preview/CreateUIDefinition.MultiVm.json',
  '0.0.1-preview/CreateUIDefinition.ProviderControl.json',
  '0.1.0-preview/CreateUIDefinition.CommonControl.json',
  '0.1.0-preview/CreateUIDefinition.MultiVm.json',
  '0.1.0-preview/CreateUIDefinition.ProviderControl.json',
  '0.1.1-preview/CreateUIDefinition.CommonControl.json',
  '0.1.1-preview/CreateUIDefinition.MultiVm.json',
  '0.1.1-preview/CreateUIDefinition.ProviderControl.json',
  '0.1.2-preview/CreateUIDefinition.CommonControl.json',
  '0.1.2-preview/CreateUIDefinition.MultiVm.json',
  '0.1.2-preview/CreateUIDefinition.ProviderControl.json',
  '2014-04-01-preview/deploymentParameters.json',
  '2014-04-01-preview/deploymentTemplate.json',
  '2015-01-01/deploymentParameters.json',
  '2015-01-01/deploymentTemplate.json',
  '2015-10-01-preview/policyDefinition.json',
  '2016-12-01/policyDefinition.json',
  '2018-05-01/policyDefinition.json',
  '2019-01-01/policyDefinition.json',
  '2019-06-01/policyDefinition.json',
  '2019-09-01/policyDefinition.json',
  '2020-09-01/policyDefinition.json',
  '2020-10-01/policyDefinition.json',
  '2018-05-01/subscriptionDeploymentParameters.json',
  '2018-05-01/subscriptionDeploymentTemplate.json',
  '2019-04-01/deploymentParameters.json',
  '2019-04-01/deploymentTemplate.json',
  '2019-03-01-hybrid/deploymentTemplate.json',
  '2019-03-01-hybrid/deploymentParameters.json',
  '2019-08-01/managementGroupDeploymentParameters.json',
  '2019-08-01/managementGroupDeploymentTemplate.json',
  '2019-08-01/tenantDeploymentParameters.json',
  '2019-08-01/tenantDeploymentTemplate.json',
  'common/definitions.json',
  'common/manuallyAddedResources.json',
  'common/autogeneratedResources.json',
  'viewdefinition/0.0.1-preview/ViewDefinition.json',
].map(p => path.resolve(`${schemasFolder}/${p}`));

const schemaPaths = listSchemaPaths(schemasFolder).filter(path => schemasToSkip.indexOf(path) == -1);
const schemaTestPaths = listSchemaPaths(schemaTestsFolder);
schemaTestPaths.push(testSchemasFolder + 'ResourceMetaSchema.tests.json');
const templateTestPaths = listSchemaPaths(templateTestsFolder);

const schemaTestMap: {[path: string]: any} = {};
for (const testPath of schemaTestPaths) {
  const contents = fs.readFileSync(testPath, { encoding: 'utf8' });
  const data = JSON.parse(contents);

  schemaTestMap[testPath] = data;
}

describe('Validate individual resource schemas', () => {
  for (const schemaPath of schemaPaths) {
    describe(schemaPath, () => {
      it(`can be parsed with JSON.parse`, async function () {
        const schema = await loadRawSchema(schemaPath);

        expect(() => JSON.parse(schema)).not.to.throw();
      });

      for (const metaSchemaPath of metaSchemaPaths) {
        it(`validates against '${metaSchemaPath}'`, async function() {
          this.timeout(60000);
          const schema = await loadSchema(schemaPath);
          const metaSchema = await loadSchema(metaSchemaPath);
  
          const validate = await ajvInstance.compileAsync(metaSchema);
          const result = await validate(schema);

          expect(result, `Validation failed with errors ${JSON.stringify(validate.errors, null, 2)}`).to.be.true;
        });
      }

      it(`can be compiled`, async function() {
        this.timeout(60000);
        const schema = await loadSchema(schemaPath);
  
        await ajvInstance.compileAsync(schema);
      });
  
      if (!schemasToSkipForCyclicValidation.has(schemaPath)) {
        it(`does not contain any cycles`, async function() {
          this.timeout(60000);
          const schema = await loadSchema(schemaPath);
    
          const cycle = findCycle(schema);
          expect(cycle, `Found cycle ${cycle?.join(' -> ')}`).to.be.undefined;
        });
      }
    });
  }
});

describe('Run individual schema test', () => {
  for (const testPath of schemaTestPaths) {
    describe(testPath, () => {
      for (const test of schemaTestMap[testPath].tests) {
        it(test.name, async function() {
          this.timeout(10000);

          await schemaTestsRunner.execute(test, loadSchema);
        });
      }
    });
  }
});

describe('Validate test templates against VSCode language service', () => {
  for (const templateTestFile of templateTestPaths) {
    it(`running schema validation on '${templateTestFile}'`, async function() {
      this.timeout(30000);

      const service = getLanguageService({
        schemaRequestService: loadRawSchema,
        workspaceContext: { 
          resolveRelativePath: (relativePath, resource) => url.resolve(resource, relativePath)
        },
      });

      const content = await readFile(templateTestFile, { encoding: 'utf8' });
      const textDocument = TextDocument.create(templateTestFile, 'json', 0, content);
      const jsonDocument = service.parseJSONDocument(textDocument);
    
      const result = await service.doValidation(textDocument, jsonDocument);
      expect(result).to.deep.equal([]);
    });
  }
});