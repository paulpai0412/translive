export function option(argumentsList, name, fallback) {
  const equals = argumentsList.find((argument) =>
    argument.startsWith(`--${name}=`),
  );
  if (equals) return equals.slice(name.length + 3);
  const index = argumentsList.indexOf(`--${name}`);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}
