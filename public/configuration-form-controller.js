import {
  applyConfigurationStructureOperation,
  configurationDocumentFromForm,
  removeConfigurationEntity,
  setConfigurationFormField,
} from "./configuration-form-support.js";
import {
  configurationCollectionDescriptor,
  configurationStructureTemplate,
} from "./configuration-form-schema.js";
import { pullRequestUpdatedWindowOperationFromForm } from "./pull-request-updated-window-form.js";

const EDIT_KINDS = new Set(["text", "integer", "number", "boolean", "scalar"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PATH_SEGMENTS = 32;
const MAX_TEMPLATE_FIELDS = 4_096;

function configurationControllerError(message) {
  return new TypeError(message);
}

function normalizedPath(value, label = "configuration path") {
  const path = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(path) ||
    Object.getPrototypeOf(path) !== Array.prototype ||
    path.length === 0 ||
    path.length > MAX_PATH_SEGMENTS
  ) {
    throw configurationControllerError(`${label} is invalid`);
  }
  const keys = Reflect.ownKeys(path);
  if (keys.length !== path.length + 1 || !keys.includes("length")) {
    throw configurationControllerError(`${label} must be a dense data array`);
  }
  return Object.freeze(
    path.map((segment) => {
      if (
        !(typeof segment === "string" || Number.isSafeInteger(segment)) ||
        `${segment}`.length === 0 ||
        DANGEROUS_KEYS.has(`${segment}`)
      ) {
        throw configurationControllerError(`${label} contains an unsafe segment`);
      }
      return `${segment}`;
    }),
  );
}

function controlEdit(control, fieldName) {
  if (!control || typeof control !== "object") {
    throw configurationControllerError("configuration control is required");
  }
  const dataset = control.dataset;
  const kind = dataset?.configurationEditKind;
  if (!EDIT_KINDS.has(kind)) {
    throw configurationControllerError("configuration control edit kind is invalid");
  }
  const path = normalizedPath(dataset?.[fieldName], "configuration control path");
  const rawValue = kind === "boolean" ? control.checked : control.value;
  if (
    (kind === "boolean" && typeof rawValue !== "boolean") ||
    (kind !== "boolean" && typeof rawValue !== "string")
  ) {
    throw configurationControllerError("configuration control value is invalid");
  }
  return Object.freeze({ path, kind, rawValue });
}

export function configurationFieldEdit(control) {
  return controlEdit(control, "configurationField");
}

function cloneTemplate(value, depth = 0) {
  if (depth > MAX_PATH_SEGMENTS) {
    throw configurationControllerError("configuration template exceeds depth limit");
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    return value.map((entry) => cloneTemplate(entry, depth + 1));
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw configurationControllerError("configuration template contains an unsafe key");
      }
      result[key] = cloneTemplate(entry, depth + 1);
    }
    return result;
  }
  throw configurationControllerError("configuration template contains unsupported data");
}

function typedTemplateValue(kind, rawValue) {
  if (!EDIT_KINDS.has(kind)) {
    throw configurationControllerError("configuration template edit kind is invalid");
  }
  if (kind === "boolean") {
    if (typeof rawValue !== "boolean") {
      throw configurationControllerError("configuration template expects a boolean");
    }
    return rawValue;
  }
  if (typeof rawValue !== "string") {
    throw configurationControllerError("configuration template expects text input");
  }
  if (kind === "text") return rawValue;
  if (kind === "integer") {
    if (!/^-?(?:0|[1-9]\d*)$/.test(rawValue)) {
      throw configurationControllerError("请输入有效整数。");
    }
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value)) {
      throw configurationControllerError("整数超出安全范围。");
    }
    return value;
  }
  if (kind === "number") {
    if (!rawValue.trim() || !Number.isFinite(Number(rawValue))) {
      throw configurationControllerError("请输入有效数字。");
    }
    const value = Number(rawValue);
    return Object.is(value, -0) ? 0 : value;
  }
  try {
    const value = JSON.parse(rawValue);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
  } catch {
    // Report one bounded scalar error below.
  }
  throw configurationControllerError("请输入字符串、数字、布尔值或 null。");
}

function samePrefix(path, prefix) {
  return prefix.every((segment, index) => path[index] === segment);
}

function setTemplateValue(root, relativePath, value) {
  if (relativePath.length === 0) return value;
  let parent = root;
  for (const segment of relativePath.slice(0, -1)) {
    if (
      parent === null ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, segment)
    ) {
      throw configurationControllerError("configuration template field is outside its root");
    }
    parent = parent[segment];
  }
  const field = relativePath.at(-1);
  if (
    parent === null ||
    typeof parent !== "object" ||
    !Object.hasOwn(parent, field)
  ) {
    throw configurationControllerError("configuration template field is outside its root");
  }
  parent[field] = value;
  return root;
}

export function configurationTemplateValue(seed, rootPath, fields) {
  const normalizedRoot = normalizedPath(rootPath, "configuration template root");
  if (
    !Array.isArray(fields) ||
    Object.getPrototypeOf(fields) !== Array.prototype ||
    fields.length > MAX_TEMPLATE_FIELDS
  ) {
    throw configurationControllerError("configuration template fields are invalid");
  }
  let result = cloneTemplate(seed);
  const seen = new Set();
  for (const field of fields) {
    if (
      field === null ||
      typeof field !== "object" ||
      Array.isArray(field) ||
      Object.getPrototypeOf(field) !== Object.prototype
    ) {
      throw configurationControllerError("configuration template field is invalid");
    }
    const path = normalizedPath(field.path, "configuration template field path");
    if (path.length < normalizedRoot.length || !samePrefix(path, normalizedRoot)) {
      throw configurationControllerError("configuration template field is outside its root");
    }
    const key = JSON.stringify(path);
    if (seen.has(key)) {
      throw configurationControllerError("configuration template field is duplicated");
    }
    seen.add(key);
    result = setTemplateValue(
      result,
      path.slice(normalizedRoot.length),
      typedTemplateValue(field.kind, field.rawValue),
    );
  }
  return result;
}

function valueAtPath(document, path) {
  let value = document;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      throw configurationControllerError("configuration structure path is unavailable");
    }
    value = value[segment];
  }
  return value;
}

function materializedConfiguration(state) {
  const result = configurationDocumentFromForm(state);
  if (!result.ok) {
    throw configurationControllerError("请先修正当前配置字段，再执行结构操作。");
  }
  return result.configuration;
}

function templateFields(container) {
  return [...container.querySelectorAll("[data-configuration-template-field]")].map(
    (control) => {
      const edit = controlEdit(control, "configurationTemplateField");
      return {
        path: edit.path,
        kind: edit.kind,
        rawValue: edit.rawValue,
      };
    },
  );
}

function templateSeed(state, button, path) {
  if (button.dataset.configurationOperation !== "replace") {
    return configurationStructureTemplate(
      path,
      button.dataset.configurationTemplateVariant ?? null,
    ).value;
  }
  if (button.dataset.configurationKey !== undefined) {
    return valueAtPath(materializedConfiguration(state), [
      ...path,
      button.dataset.configurationKey,
    ]);
  }
  if (button.dataset.configurationIndex !== undefined) {
    return valueAtPath(materializedConfiguration(state), [
      ...path,
      button.dataset.configurationIndex,
    ]);
  }
  return configurationStructureTemplate(path).value;
}

function structureOperation(state, button) {
  const operation = button.dataset.configurationOperation;
  const path = normalizedPath(button.dataset.configurationPath);
  const input = { operation, path };
  if (button.dataset.configurationKey !== undefined) {
    input.key = button.dataset.configurationKey;
  }
  if (button.dataset.configurationIndex !== undefined) {
    const index = Number(button.dataset.configurationIndex);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw configurationControllerError("configuration array identity is invalid");
    }
    input.index = index;
  }
  if (operation === "remove") return input;
  const container = button.closest("[data-configuration-structure-template]");
  if (!container) {
    throw configurationControllerError("configuration structure template is unavailable");
  }
  const rootPath = normalizedPath(
    container.dataset.configurationTemplateValueRoot,
    "configuration template root",
  );
  input.value = configurationTemplateValue(
    templateSeed(state, button, path),
    rootPath,
    templateFields(container),
  );
  if (operation === "add" && container.querySelector("[data-configuration-template-key]")) {
    input.key = container.querySelector("[data-configuration-template-key]").value;
  }
  return input;
}

function requiredWindowControl(container, selector, label) {
  const control = container?.querySelector?.(selector);
  if (!control || typeof control.value !== "string") {
    throw configurationControllerError(`${label} control is unavailable`);
  }
  return control;
}

export function configurationPullRequestWindowOperation(container) {
  if (!container || typeof container !== "object") {
    throw configurationControllerError("PR discovery window form is unavailable");
  }
  return pullRequestUpdatedWindowOperationFromForm({
    existing: container.dataset?.configurationPrWindowExisting === "true",
    mode: requiredWindowControl(
      container,
      "[data-configuration-pr-window-mode]",
      "PR discovery window mode",
    ).value,
    days: requiredWindowControl(
      container,
      "[data-configuration-pr-window-days]",
      "PR discovery rolling days",
    ).value,
    fromDate: requiredWindowControl(
      container,
      "[data-configuration-pr-window-from]",
      "PR discovery start date",
    ).value,
    throughDate: requiredWindowControl(
      container,
      "[data-configuration-pr-window-through]",
      "PR discovery end date",
    ).value,
    timeZone: requiredWindowControl(
      container,
      "[data-configuration-pr-window-time-zone]",
      "PR discovery time zone",
    ).value,
  });
}

function entityIdentity(state, operation) {
  const key = JSON.stringify(operation.path);
  const mapKinds = new Map([
    [JSON.stringify(["brainProviders"]), "provider"],
    [JSON.stringify(["employees", "roles"]), "role"],
    [JSON.stringify(["codeExecutor", "profiles"]), "profile"],
  ]);
  if (mapKinds.has(key) && typeof operation.key === "string") {
    return { kind: mapKinds.get(key), id: operation.key };
  }
  if (
    key === JSON.stringify(["codeExecutor", "workspaces"]) &&
    Number.isSafeInteger(operation.index)
  ) {
    const workspaces = valueAtPath(materializedConfiguration(state), operation.path);
    const id = workspaces[operation.index]?.id;
    return typeof id === "string" ? { kind: "workspace", id } : null;
  }
  return null;
}

function structureFocusTarget(state, operation) {
  const path = [...operation.path];
  if (operation.operation === "remove") {
    return Object.freeze({
      scope:
        Object.hasOwn(operation, "key") || Object.hasOwn(operation, "index")
          ? "collection"
          : "slot-template",
      path: Object.freeze(path),
    });
  }
  if (Object.hasOwn(operation, "key")) {
    return Object.freeze({
      scope: "entry",
      path: Object.freeze([...path, `${operation.key}`]),
    });
  }
  if (Object.hasOwn(operation, "index")) {
    return Object.freeze({
      scope: "entry",
      path: Object.freeze([...path, `${operation.index}`]),
    });
  }
  if (operation.operation === "add") {
    const collectionDescriptor = configurationCollectionDescriptor(path);
    if (collectionDescriptor?.kind === "array") {
      const configuration = materializedConfiguration(state);
      const parent = valueAtPath(configuration, path.slice(0, -1));
      const field = path.at(-1);
      let collection = [];
      if (Object.hasOwn(parent, field)) {
        collection = parent[field];
      } else if (!collectionDescriptor.optional) {
        collection = valueAtPath(configuration, path);
      }
      return Object.freeze({
        scope: "entry",
        path: Object.freeze([...path, `${collection.length}`]),
      });
    }
  }
  return Object.freeze({ scope: "slot", path: Object.freeze(path) });
}

function structureChangeOptions(state, operation) {
  const announcements = {
    add: "已新增配置项。",
    remove: "已删除配置项。",
    replace: "已替换配置项。",
  };
  return Object.freeze({
    render: true,
    operation: operation.operation,
    focusTarget: structureFocusTarget(state, operation),
    announcement: announcements[operation.operation] ?? "配置结构已更新。",
  });
}

function referencedEntityMessage(references) {
  const paths = references.slice(0, 3).map(({ path }) => path).join("、");
  const remainder = references.length > 3 ? ` 等 ${references.length} 处` : "";
  return `无法删除：该实体仍被 ${paths}${remainder} 引用，请先移除引用。`;
}

function updateTemplateScalarType(select) {
  const group = select.closest("[data-configuration-template-scalar]");
  const control = group?.querySelector("[data-configuration-template-scalar-value]");
  if (!control) {
    throw configurationControllerError("configuration scalar template is unavailable");
  }
  const type = select.value;
  if (!["null", "string", "number", "boolean"].includes(type)) {
    throw configurationControllerError("configuration scalar type is invalid");
  }
  const priorValue = control.type === "checkbox" ? `${control.checked}` : control.value;
  control.readOnly = type === "null";
  control.type = type === "boolean" ? "checkbox" : type === "number" ? "number" : "text";
  control.dataset.configurationEditKind =
    type === "null" ? "scalar" : type === "string" ? "text" : type;
  if (type === "boolean") {
    control.checked = priorValue === "true";
  } else if (type === "null") {
    control.value = "null";
  } else if (type === "number") {
    control.value = Number.isFinite(Number(priorValue)) ? priorValue : "0";
  } else {
    control.value = priorValue === "null" ? "" : priorValue;
  }
}

function eventControl(event, attribute) {
  const target = event.target;
  return target?.dataset?.[attribute] !== undefined ? target : null;
}

function pullRequestWindowContainer(control) {
  return control?.closest?.("[data-configuration-pr-window]") ?? null;
}

function markPullRequestWindowDirty(control, onInvalidate) {
  const container = pullRequestWindowContainer(control);
  if (!container) return false;
  container.dataset.configurationPrWindowDirty = "true";
  onInvalidate();
  return true;
}

function clearFieldError(control) {
  control.removeAttribute("aria-invalid");
  control.removeAttribute("data-configuration-first-invalid");
  const describedBy = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const retained = [];
  for (const id of describedBy) {
    const description = control.ownerDocument?.getElementById(id);
    if (
      id.startsWith("configuration-error-") &&
      description?.classList?.contains("configuration-field-error")
    ) {
      description.remove();
    } else {
      retained.push(id);
    }
  }
  if (retained.length > 0) {
    control.setAttribute("aria-describedby", retained.join(" "));
  } else {
    control.removeAttribute("aria-describedby");
  }
}

export function bindConfigurationFormController({
  root,
  getState,
  onStateChange,
  onInvalidate,
  onError,
}) {
  if (
    !root?.addEventListener ||
    typeof getState !== "function" ||
    typeof onStateChange !== "function" ||
    typeof onInvalidate !== "function" ||
    typeof onError !== "function"
  ) {
    throw configurationControllerError("configuration controller boundary is invalid");
  }

  function applyField(control) {
    try {
      const edit = configurationFieldEdit(control);
      const nextState = setConfigurationFormField(
        getState(),
        edit,
      );
      clearFieldError(control);
      onInvalidate();
      onStateChange(nextState, {
        render:
          edit.path[0] === "githubActions" &&
          edit.path[1] === "credentialMode",
        operation: "field",
      });
    } catch (error) {
      onError(error.message, { focus: control });
    }
  }

  function handleInput(event) {
    const field = eventControl(event, "configurationField");
    if (field && field.type !== "checkbox" && field.tagName !== "SELECT") {
      applyField(field);
      return;
    }
    if (markPullRequestWindowDirty(event.target, onInvalidate)) return;
    if (eventControl(event, "configurationTemplateField")) onInvalidate();
  }

  function handleChange(event) {
    const scalarType = eventControl(event, "configurationTemplateScalarType");
    if (scalarType) {
      try {
        updateTemplateScalarType(scalarType);
        onInvalidate();
      } catch (error) {
        onError(error.message, { focus: scalarType });
      }
      return;
    }
    const field = eventControl(event, "configurationField");
    if (field && (field.type === "checkbox" || field.tagName === "SELECT")) {
      applyField(field);
      return;
    }
    const windowMode = eventControl(event, "configurationPrWindowMode");
    if (windowMode) {
      const container = windowMode.closest?.("[data-configuration-pr-window]");
      if (container) container.dataset.configurationPrWindowDirty = "true";
      container
        ?.querySelectorAll?.("[data-configuration-pr-window-fields]")
        .forEach((fields) => {
          fields.hidden = fields.dataset.configurationPrWindowFields !== windowMode.value;
        });
      onInvalidate();
      return;
    }
    if (eventControl(event, "configurationTemplateField")) onInvalidate();
  }

  function handleSubmit(event) {
    const container = root.querySelector?.("[data-configuration-pr-window]");
    if (container?.dataset?.configurationPrWindowDirty !== "true") return;
    try {
      const operation = configurationPullRequestWindowOperation(container);
      if (operation === null) return;
      const state = getState();
      const nextState = applyConfigurationStructureOperation(state, operation);
      onStateChange(nextState, { render: false, operation: "pr-window-submit" });
    } catch (error) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      onError(error.message, {
        focus: container.querySelector?.("[data-configuration-pr-window-mode]"),
      });
    }
  }

  function handleClick(event) {
    const windowButton = event.target?.closest?.(
      "[data-configuration-pr-window-apply]",
    );
    if (windowButton && root.contains(windowButton)) {
      try {
        const state = getState();
        const container = windowButton.closest("[data-configuration-pr-window]");
        const operation = configurationPullRequestWindowOperation(container);
        if (operation === null) return;
        const nextState = applyConfigurationStructureOperation(state, operation);
        onInvalidate();
        onStateChange(nextState, structureChangeOptions(state, operation));
      } catch (error) {
        onError(error.message, { focus: windowButton });
      }
      return;
    }
    const button = event.target?.closest?.("[data-configuration-operation]");
    if (!button || !root.contains(button)) return;
    try {
      const state = getState();
      const operation = structureOperation(state, button);
      if (operation.operation === "remove") {
        const identity = entityIdentity(state, operation);
        if (identity) {
          const result = removeConfigurationEntity(state, identity);
          if (!result.removed) {
            const message = result.reason === "referenced"
              ? referencedEntityMessage(result.references)
              : "无法删除：请先修正当前配置后再试。";
            onError(message, { focus: button, code: result.reason });
            return;
          }
          onInvalidate();
          onStateChange(result.state, structureChangeOptions(state, operation));
          return;
        }
      }
      const nextState = applyConfigurationStructureOperation(state, operation);
      onInvalidate();
      onStateChange(nextState, structureChangeOptions(state, operation));
    } catch (error) {
      onError(error.message, { focus: button });
    }
  }

  root.addEventListener("input", handleInput);
  root.addEventListener("change", handleChange);
  root.addEventListener("click", handleClick);
  root.addEventListener("submit", handleSubmit);
  return Object.freeze({
    destroy() {
      root.removeEventListener("input", handleInput);
      root.removeEventListener("change", handleChange);
      root.removeEventListener("click", handleClick);
      root.removeEventListener("submit", handleSubmit);
    },
  });
}
