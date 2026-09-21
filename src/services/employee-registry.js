function registryError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

const EMPLOYEE_ID_PATTERN = /^[a-z0-9-]+$/;

function assertEmployee(employee) {
  if (!employee?.id || typeof employee.id !== "string") {
    throw new Error("注册岗位必须提供 id");
  }
  if (!EMPLOYEE_ID_PATTERN.test(employee.id)) {
    throw new Error("岗位 id 只能包含小写字母、数字和连字符");
  }
  for (const method of ["view", "roleView", "run", "control"]) {
    if (typeof employee[method] !== "function") {
      throw new Error(`岗位 ${employee.id} 必须实现 ${method}`);
    }
  }
}

export class EmployeeRegistry {
  constructor(employees = []) {
    this.employees = new Map();
    for (const employee of employees) this.register(employee);
  }

  register(employee) {
    assertEmployee(employee);
    if (this.employees.has(employee.id)) {
      throw new Error(`岗位 id 已注册: ${employee.id}`);
    }
    this.employees.set(employee.id, employee);
    return employee;
  }

  get(id) {
    return this.employees.get(id) || null;
  }

  require(id) {
    const employee = this.get(id);
    if (!employee) throw registryError(404, `找不到岗位: ${id}`);
    return employee;
  }

  async list() {
    return Promise.all(
      [...this.employees.values()].map((employee) => employee.view()),
    );
  }

  async listRoles() {
    return Promise.all(
      [...this.employees.values()].map((employee) => employee.roleView()),
    );
  }

  async view(id) {
    return this.require(id).view();
  }

  async run(id, options = {}) {
    return this.require(id).run(options);
  }

  async control(id, command, expectedRevision) {
    return this.require(id).control(command, expectedRevision);
  }

  async runAll(options = {}) {
    return Promise.all(
      [...this.employees.values()].map((employee) => employee.run(options)),
    );
  }

  async runSelected(ids, options = {}) {
    if (
      !Array.isArray(ids) ||
      Object.getPrototypeOf(ids) !== Array.prototype ||
      new Set(ids).size !== ids.length
    ) {
      throw registryError(400, "岗位列表无效");
    }
    return Promise.all(ids.map((id) => this.require(id).run(options)));
  }

  schedules() {
    return [...this.employees.values()]
      .map((employee) => ({
        id: employee.id,
        intervalMinutes: Number(employee.scheduleMinutes),
      }))
      .filter((schedule) => schedule.intervalMinutes > 0);
  }
}
