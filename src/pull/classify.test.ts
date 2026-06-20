import { test, expect } from "bun:test";
import { collectParameterStrings, extractVariableRefs, buildSearchText } from "./classify.ts";

test("collectParameterStrings flattens nested list/map params", () => {
  const params = [
    { type: "template", key: "html", value: "<script>{{GA4 ID}}</script>" },
    { type: "list", key: "rows", list: [
      { type: "map", map: [{ type: "template", key: "k", value: "{{Page Path}}" }] },
    ]},
  ];
  expect(collectParameterStrings(params)).toEqual(["<script>{{GA4 ID}}</script>", "{{Page Path}}"]);
});

test("extractVariableRefs returns unique variable names", () => {
  const refs = extractVariableRefs(["a {{X}} b {{Y}}", "{{X}}"]);
  expect(refs.sort()).toEqual(["X", "Y"]);
});

test("extractVariableRefs ignores empty braces", () => {
  expect(extractVariableRefs(["{{}} {{ Trimmed }}"])).toEqual(["Trimmed"]);
});

test("buildSearchText lowercases name and values", () => {
  expect(buildSearchText("My Tag", ["DataLayer.Foo"])).toBe("my tag\ndatalayer.foo");
});
