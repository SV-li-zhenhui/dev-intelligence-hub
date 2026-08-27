const DEFAULT_TESTING_OWNERS = Object.freeze({
  qt: Object.freeze(["qt-tester-primary", "qt-tester-secondary"]),
  bs: Object.freeze(["bs-tester"]),
});

const PRODUCT_LABELS = Object.freeze({ qt: "Qt 桌面版", bs: "B/S 版本" });
const GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function configuredOwners(configuration) {
  const value = configuration?.workCoordination?.policy
    ?.testingOwnersByProduct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [product, owners] of Object.entries(value)) {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(product)) continue;
    if (!Array.isArray(owners)) continue;
    const valid = [...new Set(owners.filter(
      (login) => typeof login === "string" && GITHUB_LOGIN.test(login),
    ))];
    if (valid.length) result[product] = valid;
  }
  return Object.keys(result).length ? result : null;
}

export function testingOwnerRouting(configuration) {
  const ownersByProduct = configuredOwners(configuration) ||
    DEFAULT_TESTING_OWNERS;
  const preferred = ["qt", "bs"];
  const products = Object.keys(ownersByProduct).sort((left, right) => {
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex < 0 ? preferred.length : leftIndex) -
        (rightIndex < 0 ? preferred.length : rightIndex);
    }
    return left.localeCompare(right);
  });
  return Object.freeze({
    ownersByProduct,
    products,
    productLabel(product) {
      return PRODUCT_LABELS[product] || product.toUpperCase();
    },
    ownerLabel(login) {
      return `@${login}`;
    },
  });
}

export function inferTestingProduct(value, availableProducts = ["qt", "bs"]) {
  const text = String(value || "");
  if (
    availableProducts.includes("bs") &&
    /(?:\bB\s*\/\s*S\b|\bBS\s*(?:版|架构|前端|后端)|\bweb\b|网页端|浏览器端)/iu.test(text)
  ) {
    return "bs";
  }
  if (availableProducts.includes("qt") && /\bQt\b|桌面版|客户端/iu.test(text)) {
    return "qt";
  }
  return availableProducts.includes("qt") ? "qt" : availableProducts[0] || "";
}
