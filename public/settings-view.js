import {
  configurationDocumentFromForm,
  configurationFormPathKey,
} from "./configuration-form-support.js";
import {
  CONFIGURATION_FORM_GROUPS,
  CONFIGURATION_FORM_SCHEMA,
  configurationCollectionDescriptor,
  configurationFieldDescriptor,
  configurationNodeLabel,
  configurationSlotDescriptor,
  configurationStructureTemplate,
} from "./configuration-form-schema.js";
import { escapeHtml } from "./view-format.js";

function pathText(path) {
  return path.map((segment) => `${segment}`).join(".");
}

function pathAttribute(path) {
  return escapeHtml(configurationFormPathKey(path));
}

function pathDomId(path) {
  return encodeURIComponent(configurationFormPathKey(path)).replaceAll("%", "_");
}

function issueIndex(issues) {
  const result = new Map();
  for (const issue of issues) {
    if (!result.has(issue.path)) result.set(issue.path, issue);
  }
  return result;
}

function fieldAccessibility(path, issue, context) {
  if (!issue) return { attributes: "", error: "" };
  const id = `configuration-error-${pathDomId(path)}`;
  const first = context.firstInvalidRendered ? "" : " data-configuration-first-invalid";
  context.firstInvalidRendered = true;
  return {
    attributes: ` aria-invalid="true" aria-describedby="${escapeHtml(id)}"${first}`,
    error: `<span id="${escapeHtml(id)}" class="configuration-field-error">${escapeHtml(issue.message)}</span>`,
  };
}

function optionValue(value) {
  return value === null ? "null" : `${value}`;
}

function scalarType(value) {
  return value === null ? "null" : typeof value;
}

function scalarEditKind(value) {
  const valueType = scalarType(value);
  return valueType === "string" ? "text" : valueType === "null" ? "scalar" : valueType;
}

function resolvedFieldDescriptor(path, value, context) {
  const descriptor = configurationFieldDescriptor(path, value);
  if (descriptor.optionsFrom === undefined) return descriptor;
  if (descriptor.optionsFrom !== "brainProviders") {
    throw new TypeError(`unsupported configuration option source: ${descriptor.optionsFrom}`);
  }
  if (!context || !Array.isArray(context.providerIds)) {
    throw new TypeError("configuration provider option source is unavailable");
  }
  return { ...descriptor, options: context.providerIds };
}

function selectControl(path, descriptor, value, attributes) {
  const hasCurrent = descriptor.options.some((option) => Object.is(option, value));
  const invalidOption = hasCurrent
    ? ""
    : `<option value="${escapeHtml(optionValue(value))}" selected data-configuration-invalid-option>无效：${escapeHtml(optionValue(value))}</option>`;
  const options = descriptor.options
    .map((option) => {
      const selected = Object.is(option, value) ? " selected" : "";
      const label = option === null ? "无条件" : `${option}`;
      return `<option value="${escapeHtml(optionValue(option))}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  const editKind = descriptor.editKind || descriptor.kind;
  return `<select data-configuration-field="${pathAttribute(path)}" data-configuration-value-kind="${escapeHtml(descriptor.kind)}" data-configuration-edit-kind="${escapeHtml(editKind)}" id="configuration-field-${pathDomId(path)}" name="${pathAttribute(path)}"${attributes}>${invalidOption}${options}</select>`;
}

function scalarControl(path, descriptor, value, attributes) {
  const valueType = scalarType(value);
  const editKind = scalarEditKind(value);
  if (value === null) {
    return selectControl(
      path,
      { ...descriptor, options: [null], editKind },
      value,
      ` data-configuration-scalar-type="null"${attributes}`,
    );
  }
  if (valueType === "boolean") {
    return `<input type="checkbox" data-configuration-field="${pathAttribute(path)}" data-configuration-value-kind="scalar" data-configuration-scalar-type="boolean" data-configuration-edit-kind="boolean" id="configuration-field-${pathDomId(path)}" name="${pathAttribute(path)}"${value ? " checked" : ""}${attributes}>`;
  }
  const type = valueType === "number" ? "number" : "text";
  return `<input type="${type}" value="${escapeHtml(value)}" data-configuration-field="${pathAttribute(path)}" data-configuration-value-kind="scalar" data-configuration-scalar-type="${escapeHtml(valueType)}" data-configuration-edit-kind="${escapeHtml(editKind)}" id="configuration-field-${pathDomId(path)}" name="${pathAttribute(path)}"${attributes}>`;
}

function inputControl(path, descriptor, value, attributes) {
  if (descriptor.control === "select") {
    return selectControl(path, descriptor, value, attributes);
  }
  if (descriptor.control === "scalar") {
    return scalarControl(path, descriptor, value, attributes);
  }
  if (descriptor.control === "checkbox") {
    return `<input type="checkbox" data-configuration-field="${pathAttribute(path)}" data-configuration-value-kind="boolean" data-configuration-edit-kind="boolean" id="configuration-field-${pathDomId(path)}" name="${pathAttribute(path)}"${value ? " checked" : ""}${attributes}>`;
  }
  const type = descriptor.control === "number" ? "number" : "text";
  const range = [
    descriptor.minimum === undefined ? "" : ` min="${descriptor.minimum}"`,
    descriptor.maximum === undefined ? "" : ` max="${descriptor.maximum}"`,
    descriptor.kind === "integer" ? " step=\"1\"" : "",
  ].join("");
  const environment =
    descriptor.control === "env-reference"
      ? ' autocomplete="off" spellcheck="false" data-configuration-value-kind="env-reference" data-configuration-edit-kind="text"'
      : ` data-configuration-value-kind="${escapeHtml(descriptor.kind)}" data-configuration-edit-kind="${escapeHtml(descriptor.kind)}"`;
  return `<input type="${type}" value="${escapeHtml(value)}" data-configuration-field="${pathAttribute(path)}" id="configuration-field-${pathDomId(path)}" name="${pathAttribute(path)}"${range}${environment}${attributes}>`;
}

function templateScalarControl(path, descriptor, value) {
  const templatePath = escapeHtml(configurationFormPathKey(path));
  const id = `configuration-template-${pathDomId(path)}`;
  const valueType = scalarType(value);
  const typeOptions = ["null", "string", "number", "boolean"]
    .map((type) => `<option value="${type}"${type === valueType ? " selected" : ""}>${type}</option>`)
    .join("");
  let valueControl;
  if (valueType === "boolean") {
    valueControl = `<input type="checkbox" id="${id}-value" data-configuration-template-field="${templatePath}" data-configuration-template-scalar-value data-configuration-edit-kind="boolean"${value ? " checked" : ""}>`;
  } else if (valueType === "number") {
    valueControl = `<input type="number" value="${escapeHtml(value)}" id="${id}-value" data-configuration-template-field="${templatePath}" data-configuration-template-scalar-value data-configuration-edit-kind="number">`;
  } else if (valueType === "string") {
    valueControl = `<input type="text" value="${escapeHtml(value)}" id="${id}-value" data-configuration-template-field="${templatePath}" data-configuration-template-scalar-value data-configuration-edit-kind="text">`;
  } else {
    valueControl = `<input type="text" value="null" readonly id="${id}-value" data-configuration-template-field="${templatePath}" data-configuration-template-scalar-value data-configuration-edit-kind="scalar">`;
  }
  return `<div class="configuration-structured-field" role="group" aria-labelledby="${id}-label" data-configuration-template-scalar>
    <span id="${id}-label">${escapeHtml(descriptor.label)}</span>
    <label for="${id}-type"><span>值类型</span><select id="${id}-type" data-configuration-template-scalar-type>${typeOptions}</select></label>
    <label for="${id}-value"><span>值</span>${valueControl}</label>
  </div>`;
}

function renderField(path, value, context, { template = false } = {}) {
  const descriptor = resolvedFieldDescriptor(path, value, context);
  if (template) {
    const templatePath = escapeHtml(configurationFormPathKey(path));
    const type = descriptor.control === "number" ? "number" : "text";
    if (descriptor.control === "scalar") {
      return templateScalarControl(path, descriptor, value);
    }
    if (descriptor.control === "checkbox") {
      return `<label class="configuration-structured-field"><span>${escapeHtml(descriptor.label)}</span><input type="checkbox" data-configuration-template-field="${templatePath}" data-configuration-edit-kind="boolean"${value ? " checked" : ""}></label>`;
    }
    if (descriptor.control === "select") {
      const options = descriptor.options
        .map((option) => `<option value="${escapeHtml(optionValue(option))}"${Object.is(option, value) ? " selected" : ""}>${escapeHtml(optionValue(option))}</option>`)
        .join("");
      return `<label class="configuration-structured-field"><span>${escapeHtml(descriptor.label)}</span><select data-configuration-template-field="${templatePath}" data-configuration-edit-kind="${escapeHtml(descriptor.kind)}">${options}</select></label>`;
    }
    const editKind = descriptor.control === "env-reference" ? "text" : descriptor.kind;
    return `<label class="configuration-structured-field"><span>${escapeHtml(descriptor.label)}</span><input type="${type}" value="${escapeHtml(value ?? "")}" data-configuration-template-field="${templatePath}" data-configuration-edit-kind="${escapeHtml(editKind)}"></label>`;
  }
  const issue = context.issues.get(pathText(path));
  const accessibility = fieldAccessibility(path, issue, context);
  const environmentHelp =
    descriptor.control === "env-reference" && !issue
      ? ' aria-describedby="configuration-env-reference-help"'
      : "";
  const control = inputControl(
    path,
    descriptor,
    value,
    `${environmentHelp}${accessibility.attributes}`,
  );
  return `<label class="configuration-structured-field${descriptor.control === "env-reference" ? " configuration-env-reference" : ""}" for="configuration-field-${pathDomId(path)}">
    <span>${escapeHtml(descriptor.label)}</span>
    ${control}
    ${accessibility.error}
  </label>`;
}

function operationButton(operation, path, label, identity = {}) {
  const identityAttributes = Object.entries(identity)
    .map(([name, value]) => ` data-configuration-${name}="${escapeHtml(value)}"`)
    .join("");
  return `<button type="button" data-configuration-operation="${escapeHtml(operation)}" data-configuration-path="${pathAttribute(path)}"${identityAttributes}>${escapeHtml(label)}</button>`;
}

function renderTemplateValue(value, path, context) {
  if (value === null || typeof value !== "object") {
    return renderField(path.length > 0 ? path : ["value"], value, context, { template: true });
  }
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => renderTemplateValue(entry, [...path, index], context))
      .join("");
  }
  return Object.entries(value)
    .map(([key, entry]) => renderTemplateValue(entry, [...path, key], context))
    .join("");
}

function addTemplate(path, descriptor, context) {
  const template = configurationStructureTemplate(path);
  const valueRoot = descriptor.kind === "map"
    ? [...path, template.key]
    : [...path, 0];
  const keyField =
    descriptor.kind === "map"
      ? `<label class="configuration-structured-field"><span>新条目标识</span><input type="text" value="${escapeHtml(template.key)}" data-configuration-template-key></label>`
      : "";
  return `<details class="configuration-structure-template" data-configuration-structure-template="${pathAttribute(path)}" data-configuration-template-value-root="${pathAttribute(valueRoot)}">
    <summary>新增${escapeHtml(descriptor.label)}</summary>
    <div class="configuration-structure-template-fields">
      ${keyField}
      ${renderTemplateValue(
        template.value,
        valueRoot,
        context,
      )}
      ${operationButton("add", path, `新增${descriptor.label}`)}
    </div>
  </details>`;
}

function entryActions(path, identity, label) {
  return `<div class="configuration-structure-actions">
    ${operationButton("remove", path, `删除${label}`, identity)}
  </div>`;
}

function replaceTemplate(path, identity, label, value, context) {
  const valueRoot = [
    ...path,
    Object.hasOwn(identity, "key") ? identity.key : identity.index,
  ];
  return `<details class="configuration-structure-template" data-configuration-structure-template="${pathAttribute(path)}" data-configuration-template-value-root="${pathAttribute(valueRoot)}" data-configuration-replace-template>
    <summary>替换${escapeHtml(label)}</summary>
    <div class="configuration-structure-template-fields">
      ${renderTemplateValue(value, valueRoot, context)}
      ${operationButton("replace", path, `替换${label}`, identity)}
    </div>
  </details>`;
}

function renderCollection(path, value, descriptor, context) {
  const entries = descriptor.kind === "array" ? value.entries() : Object.entries(value);
  const items = Array.from(entries)
    .map(([entryIdentity, entry]) => {
      const itemPath = [...path, entryIdentity];
      const label = descriptor.kind === "array" ? `第 ${Number(entryIdentity) + 1} 项` : `${entryIdentity}`;
      const operationIdentity =
        descriptor.kind === "array" ? { index: entryIdentity } : { key: entryIdentity };
      return `<article class="configuration-structured-card" data-configuration-entry="${pathAttribute(itemPath)}">
        <header><strong>${escapeHtml(label)}</strong>${entryActions(path, operationIdentity, label)}</header>
        ${replaceTemplate(path, operationIdentity, label, entry, context)}
        ${renderNode(entry, itemPath, context)}
      </article>`;
    })
    .join("");
  return `<section class="configuration-structured-collection" data-configuration-collection="${pathAttribute(path)}" data-configuration-node="${pathAttribute(path)}">
    <header><strong>${escapeHtml(descriptor.label)}</strong></header>
    ${items || `<p class="configuration-help">尚未配置${escapeHtml(descriptor.label)}。</p>`}
    ${addTemplate(path, descriptor, context)}
  </section>`;
}

function optionalCollections(path, value, context) {
  return CONFIGURATION_FORM_SCHEMA.collections
    .filter(
      (descriptor) =>
        descriptor.optional &&
        descriptor.pattern.length === path.length + 1 &&
        descriptor.pattern.slice(0, -1).every((segment, index) => segment === `${path[index]}`) &&
        !Object.hasOwn(value, descriptor.pattern.at(-1)),
    )
    .map((descriptor) => {
      const childPath = [...path, descriptor.pattern.at(-1)];
      const empty = descriptor.kind === "array" ? [] : {};
      return renderCollection(
        childPath,
        empty,
        configurationCollectionDescriptor(childPath, empty),
        context,
      );
    })
    .join("");
}

function slotActions(path, value, context) {
  const slot = configurationSlotDescriptor(path);
  if (!slot) return "";
  const actions = [];
  if (slot.nullable && value === null) {
    actions.push(renderSlotTemplate(path, slot, "add", context));
  }
  if (value !== null && slot.operations.includes("replace")) {
    actions.push(renderSlotTemplate(path, slot, "replace", context));
  }
  if (value !== null && slot.operations.includes("remove")) {
    actions.push(operationButton("remove", path, `删除${slot.label}`));
  }
  return actions.length > 0
    ? `<div class="configuration-structure-actions">${actions.join("")}</div>`
    : "";
}

function renderSlotTemplate(path, slot, operation, context) {
  const template = configurationStructureTemplate(path);
  const action = operation === "add" ? "新增" : "替换";
  return `<details class="configuration-structure-template" data-configuration-structure-template="${pathAttribute(path)}" data-configuration-template-value-root="${pathAttribute(path)}"${operation === "replace" ? " data-configuration-replace-template" : ""}>
    <summary>${action}${escapeHtml(slot.label)}</summary>
    <div class="configuration-structure-template-fields">
      ${renderTemplateValue(template.value, path, context)}
      ${operationButton(operation, path, `${action}${slot.label}`)}
    </div>
  </details>`;
}

function renderNode(value, path, context) {
  if (value === null || typeof value !== "object") {
    return `${slotActions(path, value, context)}${renderField(path, value, context)}`;
  }
  const collection = configurationCollectionDescriptor(path, value);
  if (collection) return renderCollection(path, value, collection, context);
  const children = Object.entries(value)
    .map(([key, entry]) => renderNode(entry, [...path, key], context))
    .join("");
  const label = path.length > 0 ? configurationNodeLabel(path) : "配置";
  return `<section class="configuration-structured-node" data-configuration-node="${pathAttribute(path)}">
    ${path.length > 0 ? `<h3>${escapeHtml(label)}</h3>` : ""}
    ${slotActions(path, value, context)}
    <div class="configuration-structured-grid">${children}${optionalCollections(path, value, context)}</div>
  </section>`;
}

function settingsState(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("settings options must be a plain object");
  }
  const keys = Reflect.ownKeys(options);
  const descriptor = Object.getOwnPropertyDescriptor(options, "state");
  if (
    keys.length !== 1 ||
    keys[0] !== "state" ||
    !descriptor?.enumerable ||
    !("value" in descriptor)
  ) {
    throw new TypeError("settings options.state must be a data property");
  }
  return descriptor.value;
}

export function renderConfigurationSettingsSkeleton(options) {
  const state = settingsState(options);
  const materialized = configurationDocumentFromForm(state);
  const configuration = materialized.ok
    ? materialized.configuration
    : materialized.presentation.configuration;
  const context = {
    issues: issueIndex(materialized.issues),
    firstInvalidRendered: false,
    providerIds: Object.keys(configuration.brainProviders),
  };
  const groups = CONFIGURATION_FORM_GROUPS.map((group) => {
    const content = group.roots
      .map((root) => renderNode(configuration[root], [root], context))
      .join("");
    return `<fieldset data-configuration-group="${escapeHtml(group.id)}">
      <legend>${escapeHtml(group.label)}</legend>
      <p class="configuration-help">${escapeHtml(group.description)}</p>
      ${content}
    </fieldset>`;
  }).join("");
  return `<form class="configuration-structured-form" id="configuration-editor-form" data-configuration-structured-form aria-describedby="configuration-editor-help" novalidate>
    <p id="configuration-env-reference-help" class="configuration-help">只填写环境变量名，不填写密钥值；页面不会读取或显示环境变量内容。</p>
    <div id="configuration-form-status" role="status" aria-live="polite" tabindex="-1"></div>
    ${groups}
    <button type="submit" data-configuration-submit>保存配置草稿</button>
  </form>`;
}
